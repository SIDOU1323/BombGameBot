const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

// ===================== STATE =====================
const games = {}; // channelId -> gameState

function createGame(channelId) {
  return {
    channelId,
    phase: 'joining',        // joining | playing | ended
    players: {},             // userId -> { name, spot, alive, hasBomb }
    order: [],               // userIds sorted by spot
    currentTurn: 0,
    bombHolder: null,        // userId
    ghosts: [],              // userIds of dead players
    boardMessageId: null,
    turnMessageId: null,
    joinTimeout: null,
    turnTimeout: null,
    swapRequests: {},        // requesterId -> { targetId, resolve }
  };
}

// ===================== HELPERS =====================
function buildBoard(game) {
  const rows = [];
  for (let row = 0; row < 3; row++) {
    const rowButtons = new ActionRowBuilder();
    for (let col = 0; col < 5; col++) {
      const spot = row * 5 + col + 1;
      const occupant = Object.values(game.players).find(p => p.spot === spot && p.alive);
      const label = occupant ? `${spot}-${occupant.name}` : `${spot}`;
      rowButtons.addComponents(
        new ButtonBuilder()
          .setCustomId(`spot_${spot}`)
          .setLabel(label.slice(0, 80))
          .setStyle(occupant ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(game.phase !== 'joining')
      );
    }
    rows.push(rowButtons);
  }
  return rows;
}

function buildSwapBoard(game, excludeUserId) {
  // Show alive players except the requester
  const alivePlayers = Object.entries(game.players)
    .filter(([id, p]) => p.alive && id !== excludeUserId)
    .sort(([, a], [, b]) => a.spot - b.spot);

  const rows = [];
  let currentRow = new ActionRowBuilder();
  let count = 0;

  for (const [userId, player] of alivePlayers) {
    if (count > 0 && count % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`swaptarget_${userId}`)
        .setLabel(`${player.spot}-${player.name}`)
        .setStyle(ButtonStyle.Danger)
    );
    count++;
  }
  if (count > 0) rows.push(currentRow);
  return rows;
}

function buildGhostBoard(game) {
  const alivePlayers = Object.entries(game.players)
    .filter(([, p]) => p.alive)
    .sort(([, a], [, b]) => a.spot - b.spot);

  const rows = [];
  let currentRow = new ActionRowBuilder();
  let count = 0;

  for (const [userId, player] of alivePlayers) {
    if (count > 0 && count % 5 === 0) {
      rows.push(currentRow);
      currentRow = new ActionRowBuilder();
    }
    currentRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`ghostpick_${userId}`)
        .setLabel(`${player.spot}-${player.name}`)
        .setStyle(ButtonStyle.Danger)
    );
    count++;
  }
  if (count > 0) rows.push(currentRow);
  return rows;
}

function getAliveOrder(game) {
  return game.order.filter(id => game.players[id]?.alive);
}

async function updateBoard(game, channel) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('💣 لعبة القنبلة')
      .setColor(0xff4444)
      .setDescription(
        game.phase === 'joining'
          ? '⏳ **اختر مكانك خلال 20 ثانية!**\nاضغط على رقم للجلوس فيه.'
          : '🎮 **الجولة جارية...**'
      );

    const components = buildBoard(game);

    if (game.boardMessageId) {
      const msg = await channel.messages.fetch(game.boardMessageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components });
        return;
      }
    }
    const msg = await channel.send({ embeds: [embed], components });
    game.boardMessageId = msg.id;
  } catch (e) {
    console.error('updateBoard error:', e);
  }
}

async function sendDM(user, content, components = []) {
  try {
    const dm = await user.createDM();
    return await dm.send({ content, components });
  } catch {
    return null;
  }
}

// ===================== START GAME =====================
async function startJoining(channel) {
  const game = createGame(channel.id);
  games[channel.id] = game;

  const embed = new EmbedBuilder()
    .setTitle('💣 لعبة القنبلة — اختر مكانك!')
    .setColor(0xffcc00)
    .setDescription('⏳ لديك **20 ثانية** لاختيار مكانك.\nاضغط على أي رقم للجلوس فيه.');

  const components = buildBoard(game);
  const msg = await channel.send({ embeds: [embed], components });
  game.boardMessageId = msg.id;

  game.joinTimeout = setTimeout(() => beginGame(channel, game), 20000);
}

// ===================== BEGIN GAME =====================
async function beginGame(channel, game) {
  const alivePlayers = Object.entries(game.players).filter(([, p]) => p.alive);

  if (alivePlayers.length < 2) {
    await channel.send('❌ لم ينضم كافة اللاعبين (يلزم 2 على الأقل). الجولة ملغاة.');
    delete games[channel.id];
    return;
  }

  // Sort order by spot number
  game.order = alivePlayers
    .sort(([, a], [, b]) => a.spot - b.spot)
    .map(([id]) => id);

  game.phase = 'playing';

  // Disable join buttons
  await updateBoard(game, channel);

  // Show turn order
  const orderText = game.order.map(id => `**${game.players[id].name}** — مكان ${game.players[id].spot}`).join('\n');
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('🎮 بدأت اللعبة!')
        .setColor(0x00cc66)
        .setDescription(`ترتيب اللعب:\n${orderText}`)
    ]
  });

  await plantBombRandom(channel, game);
}

// ===================== PLANT BOMB =====================
async function plantBombRandom(channel, game) {
  const alive = getAliveOrder(game);
  const idx = Math.floor(Math.random() * alive.length);
  const bombUserId = alive[idx];

  // Clear previous bomb
  for (const id of Object.keys(game.players)) game.players[id].hasBomb = false;
  game.players[bombUserId].hasBomb = true;
  game.bombHolder = bombUserId;

  const bombUser = await client.users.fetch(bombUserId);
  await sendDM(bombUser, '💣 **لديك القنبلة هذه الجولة.**\nحاول التخلص منها قبل الانفجار!');

  game.currentTurn = 0;
  await startRound(channel, game);
}

// ===================== ROUND =====================
async function startRound(channel, game) {
  const alive = getAliveOrder(game);
  if (alive.length < 2) {
    await endGame(channel, game);
    return;
  }

  await doTurn(channel, game);
}

async function doTurn(channel, game) {
  const alive = getAliveOrder(game);

  if (game.currentTurn >= alive.length) {
    // All turns done — bomb explodes
    await explode(channel, game);
    return;
  }

  const currentId = alive[game.currentTurn];
  const player = game.players[currentId];
  const user = await client.users.fetch(currentId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`stay_${channel.id}`).setLabel('✅ البقاء').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`change_${channel.id}`).setLabel('🔄 تغيير').setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setTitle(`🎯 دور ${player.name}`)
    .setColor(0x3399ff)
    .setDescription(`📍 مكانك الحالي: **${player.spot}**\n\nماذا تريد أن تفعل؟\nلديك **30 ثانية**`)

  const turnMsg = await channel.send({ embeds: [embed], components: [row] });
  game.turnMessageId = turnMsg.id;

  // DM the player
  await sendDM(user, `🎯 **دورك الآن!**\nاذهب إلى القناة واختر البقاء أو التغيير.`);

  // Auto-advance after 30 seconds
  if (game.turnTimeout) clearTimeout(game.turnTimeout);
  game.turnTimeout = setTimeout(async () => {
    await disableTurnMessage(channel, game);
    game.currentTurn++;
    await doTurn(channel, game);
  }, 30000);
}

async function disableTurnMessage(channel, game) {
  try {
    if (!game.turnMessageId) return;
    const msg = await channel.messages.fetch(game.turnMessageId).catch(() => null);
    if (msg) {
      const disabledRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('stay_done').setLabel('✅ البقاء').setStyle(ButtonStyle.Success).setDisabled(true),
        new ButtonBuilder().setCustomId('change_done').setLabel('🔄 تغيير').setStyle(ButtonStyle.Danger).setDisabled(true)
      );
      await msg.edit({ components: [disabledRow] });
    }
  } catch {}
  game.turnMessageId = null;
}

// ===================== EXPLODE =====================
async function explode(channel, game) {
  const victim = game.bombHolder;
  if (!victim || !game.players[victim]) {
    await channel.send('⚠️ خطأ: لم يتم العثور على حامل القنبلة!');
    return;
  }

  game.players[victim].alive = false;
  game.ghosts.push(victim);

  const victimName = game.players[victim].name;
  const victimUser = await client.users.fetch(victim).catch(() => null);

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('💥 انفجار!')
        .setColor(0xff0000)
        .setDescription(`❌ **${victimName}** خرج من اللعبة!\n\n👻 أصبح شبحًا.`)
    ]
  });

  await updateBoard(game, channel);

  const alive = getAliveOrder(game);
  if (alive.length < 2) {
    await endGame(channel, game);
    return;
  }

  // Ghost picks next bomb target
  if (victimUser) {
    await askGhostToPick(channel, game, victimUser);
  } else {
    await plantBombRandom(channel, game);
  }
}

// ===================== GHOST PICKS =====================
async function askGhostToPick(channel, game, ghostUser) {
  const rows = buildGhostBoard(game);
  if (rows.length === 0) {
    await plantBombRandom(channel, game);
    return;
  }

  const msg = await sendDM(ghostUser, '👻 **اختر مكان القنبلة للجولة القادمة:**', rows);

  if (!msg) {
    await plantBombRandom(channel, game);
    return;
  }

  // Store ghost's DM message for collector
  game.ghostPickMsgId = msg.id;
  game.ghostPickDMChannelId = msg.channelId;

  // Timeout: if ghost doesn't pick in 30s, pick randomly
  game.ghostTimeout = setTimeout(async () => {
    await channel.send('👻 الشبح لم يختر، سيتم اختيار القنبلة عشوائيًا...');
    await plantBombRandom(channel, game);
  }, 30000);
}

// ===================== END GAME =====================
async function endGame(channel, game) {
  const alive = getAliveOrder(game);
  game.phase = 'ended';

  if (alive.length === 1) {
    const winner = game.players[alive[0]];
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🏆 انتهت اللعبة!')
          .setColor(0xffd700)
          .setDescription(`🎉 **الفائز هو ${winner.name}!**\nمبروك! 🎊`)
      ]
    });
  } else {
    await channel.send('🏁 انتهت اللعبة!');
  }

  delete games[channel.id];
}

// ===================== SWAP LOGIC =====================
async function handleSwapRequest(channel, game, requesterId, targetId) {
  const requester = game.players[requesterId];
  const target = game.players[targetId];
  const targetUser = await client.users.fetch(targetId);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`swapaccept_${channel.id}_${requesterId}`).setLabel('✅ نعم').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`swapreject_${channel.id}_${requesterId}`).setLabel('❌ لا').setStyle(ButtonStyle.Danger)
  );

  const dm = await sendDM(
    targetUser,
    `🔄 **لديك طلب تبديل من ${requester.name}**\nهل توافق؟`,
    [row]
  );

  if (!dm) {
    await channel.send(`⚠️ لم يتمكن البوت من إرسال DM لـ **${target.name}**. يُعتبر رفضًا.`);
    await startDiceChallenge(channel, game, requesterId, targetId);
    return;
  }

  // Store pending swap
  game.swapRequests[requesterId] = { targetId };

  // Timeout: auto-reject after 20s
  setTimeout(async () => {
    if (game.swapRequests[requesterId]) {
      delete game.swapRequests[requesterId];
      await channel.send(`⏰ لم يرد **${target.name}** على طلب التبديل. يُعتبر رفضًا.\n🎲 تبدأ جولة النرد!`);
      await startDiceChallenge(channel, game, requesterId, targetId);
    }
  }, 20000);
}

async function doSwap(channel, game, idA, idB) {
  const spotA = game.players[idA].spot;
  const spotB = game.players[idB].spot;
  game.players[idA].spot = spotB;
  game.players[idB].spot = spotA;

  // Transfer bomb if needed
  if (game.players[idA].hasBomb) {
    game.players[idA].hasBomb = false;
    game.players[idB].hasBomb = true;
    game.bombHolder = idB;
    const newBombUser = await client.users.fetch(idB);
    await sendDM(newBombUser, '💣 **لديك القنبلة الآن بعد التبديل!**');
  } else if (game.players[idB].hasBomb) {
    game.players[idB].hasBomb = false;
    game.players[idA].hasBomb = true;
    game.bombHolder = idA;
    const newBombUser = await client.users.fetch(idA);
    await sendDM(newBombUser, '💣 **لديك القنبلة الآن بعد التبديل!**');
  }

  await updateBoard(game, channel);
}

// ===================== DICE =====================
async function startDiceChallenge(channel, game, requesterId, targetId) {
  const requesterUser = await client.users.fetch(requesterId);
  const targetUser = await client.users.fetch(targetId);

  await channel.send('🎲 **جولة النرد تبدأ الآن!** كل لاعب سيرمي النرد في الـ DM.');

  let requesterRoll = null;
  let targetRoll = null;

  const rollRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roll_${requesterId}`).setLabel('🎲 ارمِ النرد').setStyle(ButtonStyle.Primary)
  );
  const rollRow2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`roll_${targetId}`).setLabel('🎲 ارمِ النرد').setStyle(ButtonStyle.Primary)
  );

  await sendDM(requesterUser, '🎲 **اضغط لرمي النرد!**', [rollRow]);
  await sendDM(targetUser, '🎲 **اضغط لرمي النرد!**', [rollRow2]);

  game.diceChallenge = {
    requesterId,
    targetId,
    rolls: {},
    async checkResult() {
      if (this.rolls[requesterId] !== undefined && this.rolls[targetId] !== undefined) {
        const rRoll = this.rolls[requesterId];
        const tRoll = this.rolls[targetId];
        const rName = game.players[requesterId].name;
        const tName = game.players[targetId].name;

        await channel.send(
          `🎲 **${rName}** = ${rRoll}\n🎲 **${tName}** = ${tRoll}`
        );

        if (rRoll > tRoll) {
          await channel.send(`🏆 **${rName}** فاز بالنرد وتم التبديل!`);
          await doSwap(channel, game, requesterId, targetId);
        } else if (tRoll > rRoll) {
          await channel.send(`🏆 **${tName}** فاز بالنرد ولم يتم التبديل.`);
        } else {
          await channel.send('🤝 تعادل! لم يتم التبديل.');
        }

        delete game.diceChallenge;

        // Advance turn
        if (game.turnTimeout) clearTimeout(game.turnTimeout);
        game.currentTurn++;
        await doTurn(channel, game);
      }
    }
  };

  // Timeout for dice
  setTimeout(async () => {
    if (!game.diceChallenge) return;
    if (game.diceChallenge.rolls[requesterId] === undefined) game.diceChallenge.rolls[requesterId] = Math.floor(Math.random() * 6) + 1;
    if (game.diceChallenge.rolls[targetId] === undefined) game.diceChallenge.rolls[targetId] = Math.floor(Math.random() * 6) + 1;
    await channel.send('⏰ انتهى الوقت! سيتم رمي النرد تلقائيًا.');
    await game.diceChallenge.checkResult();
  }, 30000);
}

// ===================== EVENT: INTERACTION =====================
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId, user, channelId } = interaction;

  // ── SPOT SELECTION ──
  if (customId.startsWith('spot_')) {
    const spotNum = parseInt(customId.split('_')[1]);
    const game = games[channelId];
    if (!game || game.phase !== 'joining') {
      return interaction.reply({ content: '⚠️ اللعبة لم تبدأ بعد أو انتهت.', ephemeral: true });
    }

    // Remove player from old spot
    if (game.players[user.id]) {
      game.players[user.id].spot = spotNum;
    } else {
      game.players[user.id] = { name: user.username, spot: spotNum, alive: true, hasBomb: false };
    }

    await interaction.update({ embeds: interaction.message.embeds, components: buildBoard(game) });
    return;
  }

  // ── STAY ──
  if (customId.startsWith('stay_')) {
    const cId = customId.split('_')[1];
    const game = games[cId];
    if (!game || game.phase !== 'playing') return interaction.reply({ content: '⚠️', ephemeral: true });

    const alive = getAliveOrder(game);
    const currentId = alive[game.currentTurn];
    if (user.id !== currentId) return interaction.reply({ content: '⚠️ ليس دورك!', ephemeral: true });

    if (game.turnTimeout) clearTimeout(game.turnTimeout);
    await disableTurnMessage(interaction.channel, game);
    await interaction.reply({ content: `✅ **${game.players[user.id].name}** اختار البقاء.` });
    game.currentTurn++;
    await doTurn(interaction.channel, game);
    return;
  }

  // ── CHANGE ──
  if (customId.startsWith('change_')) {
    const cId = customId.split('_')[1];
    const game = games[cId];
    if (!game || game.phase !== 'playing') return interaction.reply({ content: '⚠️', ephemeral: true });

    const alive = getAliveOrder(game);
    const currentId = alive[game.currentTurn];
    if (user.id !== currentId) return interaction.reply({ content: '⚠️ ليس دورك!', ephemeral: true });

    if (game.turnTimeout) clearTimeout(game.turnTimeout);

    const rows = buildSwapBoard(game, user.id);
    if (rows.length === 0) {
      return interaction.reply({ content: '⚠️ لا يوجد لاعبون آخرون للتبديل معهم.', ephemeral: true });
    }

    await disableTurnMessage(interaction.channel, game);
    await interaction.reply({
      content: `🔄 **${game.players[user.id].name}** يريد التبديل! اختر لاعبًا:`,
      components: rows
    });
    return;
  }

  // ── SWAP TARGET ──
  if (customId.startsWith('swaptarget_')) {
    const targetId = customId.split('_')[1];
    // Find game
    const game = Object.values(games).find(g =>
      g.phase === 'playing' && getAliveOrder(g)[g.currentTurn] === user.id
    );
    if (!game) return interaction.reply({ content: '⚠️ لا يمكن إتمام الطلب.', ephemeral: true });

    await interaction.update({ content: `🔄 تم إرسال طلب التبديل لـ **${game.players[targetId]?.name}**`, components: [] });
    await handleSwapRequest(interaction.channel, game, user.id, targetId);
    return;
  }

  // ── SWAP ACCEPT ──
  if (customId.startsWith('swapaccept_')) {
    const parts = customId.split('_');
    const cId = parts[1];
    const requesterId = parts[2];
    const game = games[cId];
    if (!game || !game.swapRequests[requesterId]) return interaction.reply({ content: '⚠️ انتهت صلاحية الطلب.', ephemeral: true });

    const { targetId } = game.swapRequests[requesterId];
    if (user.id !== targetId) return interaction.reply({ content: '⚠️ هذا الطلب ليس لك.', ephemeral: true });

    delete game.swapRequests[requesterId];
    await interaction.update({ content: '✅ قبلت التبديل!', components: [] });

    const channel = await client.channels.fetch(cId);
    await channel.send(`✅ **${game.players[targetId].name}** قبل التبديل مع **${game.players[requesterId].name}**!`);
    await doSwap(channel, game, requesterId, targetId);

    if (game.turnTimeout) clearTimeout(game.turnTimeout);
    game.currentTurn++;
    await doTurn(channel, game);
    return;
  }

  // ── SWAP REJECT ──
  if (customId.startsWith('swapreject_')) {
    const parts = customId.split('_');
    const cId = parts[1];
    const requesterId = parts[2];
    const game = games[cId];
    if (!game || !game.swapRequests[requesterId]) return interaction.reply({ content: '⚠️ انتهت صلاحية الطلب.', ephemeral: true });

    const { targetId } = game.swapRequests[requesterId];
    if (user.id !== targetId) return interaction.reply({ content: '⚠️ هذا الطلب ليس لك.', ephemeral: true });

    delete game.swapRequests[requesterId];
    await interaction.update({ content: '❌ رفضت التبديل.', components: [] });

    const channel = await client.channels.fetch(cId);
    await channel.send(`❌ **${game.players[targetId].name}** رفض التبديل! 🎲 تبدأ جولة النرد!`);
    await startDiceChallenge(channel, game, requesterId, targetId);
    return;
  }

  // ── DICE ROLL ──
  if (customId.startsWith('roll_')) {
    const rollerId = customId.split('_')[1];
    if (user.id !== rollerId) return interaction.reply({ content: '⚠️ هذا النرد ليس لك!', ephemeral: true });

    // Find game with dice challenge
    const game = Object.values(games).find(g =>
      g.diceChallenge &&
      (g.diceChallenge.requesterId === user.id || g.diceChallenge.targetId === user.id)
    );
    if (!game || !game.diceChallenge) return interaction.reply({ content: '⚠️ لا يوجد تحدي نرد حاليًا.', ephemeral: true });
    if (game.diceChallenge.rolls[user.id] !== undefined) return interaction.reply({ content: '⚠️ رميت النرد بالفعل!', ephemeral: true });

    const roll = Math.floor(Math.random() * 6) + 1;
    game.diceChallenge.rolls[user.id] = roll;

    await interaction.update({ content: `🎲 رميت النرد وحصلت على: **${roll}**`, components: [] });
    await game.diceChallenge.checkResult();
    return;
  }

  // ── GHOST PICK ──
  if (customId.startsWith('ghostpick_')) {
    const pickedId = customId.split('_')[1];

    // Find game where user is a ghost
    const game = Object.values(games).find(g =>
      g.ghosts.includes(user.id)
    );
    if (!game) return interaction.reply({ content: '⚠️', ephemeral: true });

    if (game.ghostTimeout) clearTimeout(game.ghostTimeout);
    delete game.ghostPickMsgId;

    if (!game.players[pickedId]?.alive) {
      return interaction.reply({ content: '⚠️ اللاعب الذي اخترته لم يعد حيًا!', ephemeral: true });
    }

    // Set bomb
    for (const id of Object.keys(game.players)) game.players[id].hasBomb = false;
    game.players[pickedId].hasBomb = true;
    game.bombHolder = pickedId;

    const bombUser = await client.users.fetch(pickedId);
    await sendDM(bombUser, '💣 **لديك القنبلة هذه الجولة.**\nحاول التخلص منها قبل الانفجار!');

    await interaction.update({ content: `✅ اخترت مكان ${game.players[pickedId].name} لزرع القنبلة.`, components: [] });

    const channel = await client.channels.fetch(game.channelId);
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('💣 تم زرع القنبلة')
          .setColor(0xff6600)
          .setDescription('💣 تم زرع القنبلة وبدأت الجولة الجديدة!')
      ]
    });

    game.currentTurn = 0;
    await startRound(channel, game);
    return;
  }
});

// ===================== EVENT: MESSAGE =====================
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.trim().toLowerCase() !== '!bomb') return;

  const channelId = message.channel.id;
  if (games[channelId]) {
    return message.reply('⚠️ يوجد لعبة جارية بالفعل في هذه القناة!');
  }

  await startJoining(message.channel);
});

// ===================== READY =====================
client.once('ready', () => {
  console.log(`✅ البوت شغال: ${client.user.tag}`);
  client.user.setActivity('💣 !bomb', { type: 0 });
});

// ===================== TOKEN =====================
client.login(process.env.TOKEN);