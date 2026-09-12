const admin = require('firebase-admin');
const axios = require('axios');

// אתחול Firebase Admin SDK
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("Firebase Admin Initialized successfully.");
    }
  } catch (err) {
    console.error("Failed to initialize Firebase Admin:", err.message);
  }
}

const db = admin.apps.length ? admin.firestore() : null;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Telegram Bot is running');
  }

  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== expectedSecret) {
      console.warn('Rejected webhook call with bad secret token');
      return res.status(401).send('Unauthorized');
    }
  }

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).send('No message found');
  }

  const message = update.message;
  const chatId = message.chat.id;
  const text = (message.text || message.caption || '').trim();

  // 1. פקודת /start תמיד מורשית לכולם כדי לגלות את מזהה ה-Chat ID
  if (text.startsWith('/start')) {
    const responseText = `👋 שלום אילאי!\n\nהבוט של *ILAI FITNESS* מחובר לענן בהצלחה.\n\n🔑 מזהה ה-Chat ID שלך הוא:\n\`${chatId}\`\n\nהעתק מזהה זה והזן אותו תחת הגדרות הסביבה של Vercel (בשם \`TELEGRAM_ALLOWED_CHAT_ID\`) כדי לאבטח את הבוט.`;
    await sendTelegramMessage(chatId, responseText);
    return res.status(200).send('OK');
  }

  // 2. אימות אבטחה: האם השולח מורשה להשתמש בבוט?
  const allowedChatId = process.env.TELEGRAM_ALLOWED_CHAT_ID;
  if (!allowedChatId || String(chatId) !== String(allowedChatId)) {
    await sendTelegramMessage(chatId, "⚠️ גישה חסומה. אינך מורשה להשתמש בבוט זה. ודא שמזהה ה-Chat ID שלך מוגדר נכון ב-Vercel.");
    return res.status(200).send('Unauthorized');
  }

  // 3. בדיקה אם מסד הנתונים מחובר
  if (!db) {
    await sendTelegramMessage(chatId, "❌ שגיאה: Firebase אינו מוגדר או מחובר כראוי בשרת. אנא הגדר את המשתנה \`FIREBASE_SERVICE_ACCOUNT\` ב-Vercel.");
    return res.status(200).send('No DB');
  }

  // 4. פענוח פקודות והודעות
  try {
    if (text === '/list') {
      const snapshot = await db.collection('clients').where('status', '==', 'active').get();
      if (snapshot.empty) {
        await sendTelegramMessage(chatId, "אין כרגע מתאמנים פעילים בליווי.");
        return res.status(200).send('OK');
      }

      let clientListText = `*📋 רשימת מתאמנים פעילים (סה"כ ${snapshot.size}):*\n\n`;
      snapshot.forEach(doc => {
        const c = doc.data();
        const attention = c.needsAttention ? '🔴 ' : '🟢 ';
        clientListText += `${attention}*${c.name}* - ${c.goal || 'ללא מטרה'}\n`;
      });
      await sendTelegramMessage(chatId, clientListText);
    } 
    else if (text.startsWith('/client')) {
      const parts = text.split(' ');
      if (parts.length < 2) {
        await sendTelegramMessage(chatId, "השתמש בפורמט: \n`/client [שם המתאמן]`");
        return res.status(200).send('OK');
      }
      
      const queryName = parts.slice(1).join(' ').toLowerCase();
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      let lastWeight = 'אין שקילה';
      if (client.checkins && client.checkins.length > 0) {
        lastWeight = `${client.checkins[client.checkins.length - 1].weight} ק״ג`;
      }

      let macros = 'לא הוגדר';
      if (client.macroCalculated) {
        macros = `${client.macroCalculated.targetCalories} קלוריות | חלבון: ${client.macroCalculated.targetProtein}ג'`;
      }

      const clientCard = `👤 *מתאמן: ${client.name}*\n\n📞 טלפון: ${client.phone}\n🎯 מטרה: ${client.goal || 'לא צוינה'}\n⚖️ משקל אחרון: ${lastWeight}\n🍎 מאקרו יומי: ${macros}\n⚠️ מצב: ${client.needsAttention ? 'נפילה/קושי' : 'תקין'}\n📝 הערות: ${client.notes || 'אין'}`;
      await sendTelegramMessage(chatId, clientCard);
    }
    else if (text.startsWith('/weigh')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        await sendTelegramMessage(chatId, "השתמש בפורמט: \n`/weigh [שם המתאמן] [משקל]`");
        return res.status(200).send('OK');
      }

      const weightVal = parseFloat(parts[parts.length - 1]);
      if (isNaN(weightVal)) {
        await sendTelegramMessage(chatId, "❌ משקל לא תקין. נא להזין מספר.");
        return res.status(200).send('OK');
      }

      const queryName = parts.slice(1, parts.length - 1).join(' ').toLowerCase();
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      if (!client.checkins) client.checkins = [];
      const todayDate = new Date().toISOString().split('T')[0];
      
      client.checkins.push({
        date: todayDate,
        weight: weightVal,
        bodyFat: null,
        waist: null,
        adherenceNutrition: 5,
        adherenceTraining: 5,
        notes: 'עודכן ישירות מבוט הטלגרם',
        isDrop: false
      });
      client.checkins.sort((a, b) => new Date(a.date) - new Date(b.date));
      client.needsAttention = false;

      await db.collection('clients').doc(client.id).set(client);
      await sendTelegramMessage(chatId, `⚖️ שקילה עודכנה בהצלחה!\n\n👤 מתאמן: *${client.name}*\n📅 תאריך: ${todayDate}\n📈 משקל: *${weightVal} ק״ג*`);
    }
    else if (text.startsWith('/notes')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        await sendTelegramMessage(chatId, "השתמש בפורמט: \n`/notes [שם המתאמן] [הערה חדשה]`");
        return res.status(200).send('OK');
      }

      const noteText = parts.slice(2).join(' ');
      const queryName = parts[1].toLowerCase();
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      client.notes = (client.notes ? client.notes + '\n' : '') + noteText;
      await db.collection('clients').doc(client.id).set(client);
      await sendTelegramMessage(chatId, `📝 הערה נוספה בהצלחה למתאמן *${client.name}*:\n"${noteText}"`);
    }
    else if (text.startsWith('/macros') || text.startsWith('/macro') || text.startsWith('/target')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        let help = "🎯 *הגדרת מכסות קלוריות, מאקרו וקלוריות חופשיות:*\n\n";
        help += "1️⃣ *לפי מכסות קלוריות (חלבון, פחמימה, שומן, [חופשיות]):*\n`/macros [שם] 900 700 250 150`\n(900 קל' חלבון, 700 פחמימה, 250 שומן, 150 חופשיות = 2000 סה״כ)\n\n";
        help += "2️⃣ *לפי גרמים:*\n`/macros [שם] 2000 160 200 55 150`\n(2000 קק״ל, 160ג' חלבון, 200ג' פחמימה, 55ג' שומן, 150 קל' חופשיות)";
        await sendTelegramMessage(chatId, help);
        return res.status(200).send('OK');
      }

      const queryName = parts[1].toLowerCase();
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      let cal, proG, carbG, fatG, proCal, carbCal, fatCal, freeCal = 0;

      if (parts.length === 5) {
        proCal = parseFloat(parts[2]) || 800;
        carbCal = parseFloat(parts[3]) || 800;
        fatCal = parseFloat(parts[4]) || 400;
        freeCal = 0;
        cal = proCal + carbCal + fatCal;
        proG = Math.round((proCal / 4) * 10) / 10;
        carbG = Math.round((carbCal / 4) * 10) / 10;
        fatG = Math.round((fatCal / 9) * 10) / 10;
      } else if (parts.length === 6) {
        proCal = parseFloat(parts[2]) || 800;
        carbCal = parseFloat(parts[3]) || 700;
        fatCal = parseFloat(parts[4]) || 250;
        freeCal = parseFloat(parts[5]) || 0;
        cal = proCal + carbCal + fatCal + freeCal;
        proG = Math.round((proCal / 4) * 10) / 10;
        carbG = Math.round((carbCal / 4) * 10) / 10;
        fatG = Math.round((fatCal / 9) * 10) / 10;
      } else if (parts.length >= 7) {
        cal = parseFloat(parts[2]) || 2000;
        proG = parseFloat(parts[3]) || 160;
        carbG = parseFloat(parts[4]) || 200;
        fatG = parseFloat(parts[5]) || 55;
        freeCal = parseFloat(parts[6]) || 0;
        proCal = Math.round(proG * 4);
        carbCal = Math.round(carbG * 4);
        fatCal = Math.round(fatG * 9);
      } else {
        cal = parseFloat(parts[2]) || 2000;
        proG = parseFloat(parts[3]) || 160;
        carbG = parseFloat(parts[4]) || 220;
        fatG = parseFloat(parts[5]) || 65;
        freeCal = 0;
        proCal = Math.round(proG * 4);
        carbCal = Math.round(carbG * 4);
        fatCal = Math.round(fatG * 9);
      }

      client.targetCalories = cal;
      client.targetProtein = proG;
      client.targetCarbs = carbG;
      client.targetFat = fatG;
      client.targetProteinCal = proCal;
      client.targetCarbsCal = carbCal;
      client.targetFatCal = fatCal;
      client.targetFreeCal = freeCal;
      
      client.macroCalculated = {
        targetCalories: cal,
        targetProtein: proG,
        targetCarbs: carbG,
        targetFat: fatG,
        targetProteinCal: proCal,
        targetCarbsCal: carbCal,
        targetFatCal: fatCal,
        targetFreeCal: freeCal
      };

      await db.collection('clients').doc(client.id).set(client);

      let replyMsg = `🎯 *מכסות קלוריות, מאקרו וקלוריות חופשיות עודכנו עבור ${client.name}!*\n\n`;
      replyMsg += `🔥 *סך יעד קלורי:* ${cal} קק״ל / יום\n\n`;
      replyMsg += `🥩 *מכסת חלבון:* ${proCal} קק״ל (${proG} גרם) — ${Math.round((proCal/cal)*100)}%\n`;
      replyMsg += `🌾 *מכסת פחמימות:* ${carbCal} קק״ל (${carbG} גרם) — ${Math.round((carbCal/cal)*100)}%\n`;
      replyMsg += `🥑 *מכסת שומן:* ${fatCal} קק״ל (${fatG} גרם) — ${Math.round((fatCal/cal)*100)}%\n`;
      if (freeCal > 0) {
        replyMsg += `🍨 *תקציב קלוריות חופשיות:* ${freeCal} קק״ל — ${Math.round((freeCal/cal)*100)}%\n`;
      }
      replyMsg += `\n⚡ מסונכרן חי לענן, לפורטל ולסוכן ה-AI של המתאמן.`;

      await sendTelegramMessage(chatId, replyMsg);
      return res.status(200).send('OK');
    }
    else if (text.startsWith('/food') || text.startsWith('/eat')) {
      const parts = text.split(' ');
      if (parts.length < 3) {
        await sendTelegramMessage(chatId, "השתמש בפורמט: \n`/food [שם המתאמן] [תיאור המאכל או הארוחה]`");
        return res.status(200).send('OK');
      }

      const queryName = parts[1].toLowerCase();
      const foodDesc = parts.slice(2).join(' ');
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      await sendTelegramMessage(chatId, `⏳ מנתח ומזין ארוחה עבור *${client.name}*...`);
      await processAndLogMeal(chatId, client, foodDesc);
      return res.status(200).send('OK');
    }
        else if (text.startsWith('/water') || text.startsWith('/drink')) {
      const parts = text.split(' ');
      let queryName = '';
      let amountStr = '';
      if (parts.length === 2) {
        amountStr = parts[1];
      } else if (parts.length >= 3) {
        queryName = parts.slice(1, parts.length - 1).join(' ').toLowerCase();
        amountStr = parts[parts.length - 1];
      }
      let client = null;
      if (queryName) {
        client = await findClientByName(queryName);
      } else {
        const snapshot = await db.collection('clients').where('status', '==', 'active').get();
        const activeClients = [];
        snapshot.forEach(doc => activeClients.push(doc.data()));
        client = activeClients[0] || null;
      }
      if (!client) {
        await sendTelegramMessage(chatId, '❌ לא נמצא מתאמן להזנת מים. השתמש בפורמט: `/water [שם] [כמות במ״ל]` או `/water 500`');
        return res.status(200).send('OK');
      }
      const amount = parseWaterInput(amountStr || '500') || 500;
      await processAndLogWater(chatId, client, amount);
      return res.status(200).send('OK');
    }
    else if (text.startsWith('/steps') || text.startsWith('/step') || text.startsWith('/walk')) {
      const parts = text.split(' ');
      let queryName = '';
      let stepsStr = '';
      if (parts.length === 2) {
        stepsStr = parts[1];
      } else if (parts.length >= 3) {
        queryName = parts.slice(1, parts.length - 1).join(' ').toLowerCase();
        stepsStr = parts[parts.length - 1];
      }
      let client = null;
      if (queryName) {
        client = await findClientByName(queryName);
      } else {
        const snapshot = await db.collection('clients').where('status', '==', 'active').get();
        const activeClients = [];
        snapshot.forEach(doc => activeClients.push(doc.data()));
        client = activeClients[0] || null;
      }
      if (!client) {
        await sendTelegramMessage(chatId, '❌ לא נמצא מתאמן להזנת צעדים. השתמש בפורמט: `/steps [שם] [כמות צעדים]` או `/steps 8500`');
        return res.status(200).send('OK');
      }
      const stepsCount = parseStepsInput(stepsStr || '10000') || 10000;
      await processAndLogSteps(chatId, client, stepsCount);
      return res.status(200).send('OK');
    }
    else if (text.startsWith('/remind') || text.startsWith('/reminder')) {
      const parts = text.split(' ');
      if (parts.length < 2) {
        let helpRemind = '📲 *שליחת תזכורות וואטסאפ למתאמנים:*\n\n';
        helpRemind += '💧 מים: `/remind [שם] water`\n';
        helpRemind += '👣 צעדים: `/remind [שם] steps`\n';
        helpRemind += '🥑 יומן תזונה: `/remind [שם] food`\n';
        helpRemind += '🌙 סגירת יום: `/remind [שם] close`\n';
        helpRemind += '📝 שיקוף סופ״ש: `/remind [שם] weekend`\n';
        helpRemind += '⚖️ שקילה שבועית: `/remind [שם] weigh`';
        await sendTelegramMessage(chatId, helpRemind);
        return res.status(200).send('OK');
      }
      let type = 'water';
      let queryName = '';
      const lastPart = parts[parts.length - 1].toLowerCase();
      if (['water', 'steps', 'food', 'close', 'weekend', 'weigh'].includes(lastPart)) {
        type = lastPart;
        queryName = parts.slice(1, parts.length - 1).join(' ').toLowerCase();
      } else {
        queryName = parts.slice(1).join(' ').toLowerCase();
      }
      let client = null;
      if (queryName) {
        client = await findClientByName(queryName);
      } else {
        const snapshot = await db.collection('clients').where('status', '==', 'active').get();
        const activeClients = [];
        snapshot.forEach(doc => activeClients.push(doc.data()));
        client = activeClients[0] || null;
      }
      if (!client) {
        await sendTelegramMessage(chatId, '❌ לא נמצא מתאמן בשם: ' + queryName);
        return res.status(200).send('OK');
      }
      const remindData = buildReminderMessage(client, type);
      let replyRemind = '📲 *הודעת תזכורת מוכנה עבור ' + client.name + ' (' + remindData.title + '):*\n\n';
      replyRemind += '💬 *טקסט ההודעה:*\n"' + remindData.message + '"\n\n';
      replyRemind += '🔗 [לחץ כאן לשליחה ישירה בוואטסאפ](' + remindData.link + ')';
      await sendTelegramMessage(chatId, replyRemind);
      return res.status(200).send('OK');
    }
    else if (text.startsWith('/done')) {
      const parts = text.split(' ');
      if (parts.length < 2) {
        await sendTelegramMessage(chatId, "השתמש בפורמט: \n`/done [שם המתאמן]`");
        return res.status(200).send('OK');
      }

      const queryName = parts.slice(1).join(' ').toLowerCase();
      const client = await findClientByName(queryName);

      if (!client) {
        await sendTelegramMessage(chatId, `❌ לא נמצא מתאמן בשם: ${queryName}`);
        return res.status(200).send('OK');
      }

      const scheduleSnap = await db.collection('config').doc('schedule').get();
      if (scheduleSnap.exists) {
        const scheduleData = scheduleSnap.data();
        const events = scheduleData.events || [];
        const nextEvent = events.find(e => e.clientId === client.id && e.status === 'scheduled');
        
        if (nextEvent) {
          nextEvent.status = 'completed';
          client.personalSessionStatus = 'completed';
          
          await db.collection('config').doc('schedule').set({ events: events });
          await db.collection('clients').doc(client.id).set(client);
          await sendTelegramMessage(chatId, `✅ סימנתי את פגישת ה-${nextEvent.type === 'zoom' ? 'זום' : 'אימון 1:1'} של *${client.name}* מיום ${nextEvent.date} כבוצעה!`);
        } else {
          await sendTelegramMessage(chatId, `לא נמצאו פגישות מתוזמנות שממתינות לביצוע עבור *${client.name}*.`);
        }
      } else {
        await sendTelegramMessage(chatId, "לא נמצאו פגישות מתוזמנות במערכת.");
      }
      return res.status(200).send('OK');
    }
    else {
      // ⚡ זיהוי חופשי של הודעת אוכל ורישום ישיר ללא צורך בפקודות!
      const snapshot = await db.collection('clients').where('status', '==', 'active').get();
      const activeClients = [];
      snapshot.forEach(doc => activeClients.push(doc.data()));

      let targetClient = null;
      let foodDesc = text;

            // בדיקה האם ההודעה היא עדכון מים
      if (isWaterQuery(text)) {
        let targetClient = null;
        for (const c of activeClients) {
          const firstName = (c.name || '').split(' ')[0].toLowerCase();
          const fullName = (c.name || '').toLowerCase();
          if (text.toLowerCase().includes(firstName) || text.toLowerCase().includes(fullName)) {
            targetClient = c;
            break;
          }
        }
        if (!targetClient) targetClient = activeClients[0];
        if (targetClient) {
          const amount = parseWaterInput(text);
          if (amount > 0) {
            await processAndLogWater(chatId, targetClient, amount);
            return res.status(200).send('OK');
          }
        }
      }

      // בדיקה האם ההודעה היא עדכון צעדים
      if (isStepsQuery(text)) {
        let targetClient = null;
        for (const c of activeClients) {
          const firstName = (c.name || '').split(' ')[0].toLowerCase();
          const fullName = (c.name || '').toLowerCase();
          if (text.toLowerCase().includes(firstName) || text.toLowerCase().includes(fullName)) {
            targetClient = c;
            break;
          }
        }
        if (!targetClient) targetClient = activeClients[0];
        if (targetClient) {
          const stepsCount = parseStepsInput(text);
          if (stepsCount > 0) {
            await processAndLogSteps(chatId, targetClient, stepsCount);
            return res.status(200).send('OK');
          }
        }
      }

      // בדיקה האם ההודעה מתחילה בשם של אחד המתאמנים הפעילים
      for (const c of activeClients) {
        const firstName = (c.name || '').split(' ')[0].toLowerCase();
        const fullName = (c.name || '').toLowerCase();
        if (text.toLowerCase().startsWith(firstName) || text.toLowerCase().startsWith(fullName)) {
          targetClient = c;
          foodDesc = text.replace(new RegExp('^' + firstName + '|^' + fullName, 'i'), '').trim();
          foodDesc = foodDesc.replace(/^(אכל|אכלה|הזין|הזינה|מנה|:|-)\s*/i, '').trim();
          break;
        }
      }

      if (!targetClient && activeClients.length === 1) {
        targetClient = activeClients[0];
      } else if (!targetClient && activeClients.length > 1 && isLikelyFoodQuery(text)) {
        targetClient = activeClients[0];
      }

      if (targetClient && (isLikelyFoodQuery(foodDesc) || isLikelyFoodQuery(text) || foodDesc.length > 2)) {
        await sendTelegramMessage(chatId, `⏳ מנתח ומזין ארוחה עבור *${targetClient.name}*...`);
        const ok = await processAndLogMeal(chatId, targetClient, foodDesc || text);
        if (ok) return res.status(200).send('OK');
      }

      // עזרה והסבר על פקודות
            // עזרה והסבר על פקודות
      let helpText = '*🤖 בוט עוזר המאמן - ILAI FITNESS*\n\n';
      helpText += '*🥑 רישום ארוחה חופשי (0 מאמץ):*\n• `150 גרם נוטלה`\n• `אלירן 180 גרם חזה עוף ואורז`\n• /food `[שם] [מאכל]`\n\n';
      helpText += '*💧 מעקב שתיית מים וצעדים חי:*\n• `שתיתי 500 מ״ל מים` / `+500 מים` / /water `500`\n• `עשיתי 8500 צעדים` / /steps `8500`\n\n';
      helpText += '*📲 תזכורות מהירות לוואטסאפ:*\n• /remind `[שם] water/steps/food/close/weekend`\n\n';
      helpText += '*📋 ניהול ועדכונים:*\n• /list - רשימת המתאמנים הפעילים.\n• /client `[שם]` - כרטיס מתאמן.\n• /macros `[שם] 900 700 250 150` - עדכון מאקרו.\n• /weigh `[שם] [משקל]` - שקילה.\n• /notes `[שם] [טקסט]` - הערה.\n• /done `[שם]` - סימון אימון/פגישה.';
      await sendTelegramMessage(chatId, helpText);
    }
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(chatId, `❌ שגיאה בביצוע הפקודה: ${error.message}`);
  }

  return res.status(200).send('OK');
};

// פונקציית עזר לרישום והזנת ארוחה
async function processAndLogMeal(chatId, client, foodDesc) {
  const mealData = await analyzeFoodQueryWithAi(foodDesc, client);
  if (!mealData || typeof mealData.calories !== 'number' || mealData.calories < 10) {
    await sendTelegramMessage(chatId, "❌ לא הצלחתי לחשב את הארוחה במדויק. אנא ציין כמות או מאכל ברור יותר.");
    return false;
  }

  if (!client.foodLogs) client.foodLogs = [];
  const todayDate = new Date().toISOString().split('T')[0];
  const timeStr = new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

  const hour = new Date().getHours();
  let mealType = 'ארוחת צהריים';
  if (hour >= 5 && hour < 11.5) mealType = 'ארוחת בוקר';
  else if (hour >= 11.5 && hour < 16.5) mealType = 'ארוחת צהריים';
  else if (hour >= 16.5 && hour < 19.5) mealType = 'ארוחת ביניים';
  else mealType = 'ארוחת ערב';

  client.foodLogs.unshift({
    id: 'fl_' + Date.now(),
    date: todayDate,
    time: timeStr,
    mealType: mealType,
    description: foodDesc,
    calories: Math.round(mealData.calories),
    protein: Math.round((mealData.protein || 0) * 10) / 10,
    carbs: Math.round((mealData.carbs || 0) * 10) / 10,
    fat: Math.round((mealData.fat || 0) * 10) / 10,
    items: mealData.items || [],
    photo: ''
  });

  await db.collection('clients').doc(client.id).set(client);

  let replyMsg = `🥑 *ארוחה הוזנה בהצלחה ליומן של ${client.name}!*\n\n`;
  replyMsg += `🍽️ *מאכל:* ${foodDesc}\n`;
  replyMsg += `⏰ *ארוחה:* ${mealType} (${timeStr})\n`;
  replyMsg += `🔥 *קלוריות:* ${Math.round(mealData.calories)} קק״ל\n`;
  replyMsg += `💪 *חלבון:* ${Math.round((mealData.protein||0)*10)/10}ג' | 🌾 *פחמימות:* ${Math.round((mealData.carbs||0)*10)/10}ג' | 🥑 *שומן:* ${Math.round((mealData.fat||0)*10)/10}ג'\n\n`;
  if (mealData.coachInsight) {
    replyMsg += `💬 *תובנת המאמן אילאי:*\n"${mealData.coachInsight}"`;
  }

  await sendTelegramMessage(chatId, replyMsg);
  return true;
}

// פונקציית עזר למציאת לקוח לפי שם חלקי
async function findClientByName(queryName) {
  const snapshot = await db.collection('clients').get();
  let found = null;
  snapshot.forEach(doc => {
    const c = doc.data();
    if ((c.name || '').toLowerCase().includes(queryName)) {
      found = c;
    }
  });
  return found;
}

// שליחת הודעה חזרה לטלגרם
async function sendTelegramMessage(chatId, text) {
  if (!BOT_TOKEN) {
    console.error("Missing TELEGRAM_BOT_TOKEN");
    return;
  }
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    });
  } catch (err) {
    console.error("Telegram API SendMessage Error:", err.message);
  }
}

// בדיקה האם הודעה היא תיאור מאכל
function isLikelyFoodQuery(t) {
  const s = (t || '').toLowerCase();
  const foodKeywords = [
    'גרם', 'כף', 'כוס', 'נוטלה', 'חזה עוף', 'אורז', 'קוטג', 'ביצים', 'ביצה',
    'טונה', 'לחם', 'פיתה', 'לאפה', 'שווארמה', 'סלמון', 'חלבון', 'שוקולד',
    'אכלתי', 'בטטה', 'בננה', 'תפוח', 'שמן', 'טחינה', 'פיצה', 'המבורגר',
    'שניצל', 'פסטה', 'יוגורט', 'קלוריות', 'באגט', 'בגט', 'חביתה', 'מיונז',
    'פרו', 'סלט', 'טוסט', 'גבינה', 'אוכל', 'ארוחה', 'עוגה', 'קפה', 'נשנוש'
  ];
  return foodKeywords.some(kw => s.includes(kw)) && !s.startsWith('/');
}

// ניתוח מאכל עם Gemini ומאגר המזון הישראלי
async function analyzeFoodQueryWithAi(foodQuery, client = null) {
  const key = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42TEVQRWtCdmxJU2o4TWR2eGlsei1QV29UMElqeU45dXNLWkgtTXVIQnBmVHc=', 'base64').toString('utf8');
  
  const targetCal = client?.macroCalculated?.targetCalories || client?.targetCalories || 2000;
  const targetPro = client?.macroCalculated?.targetProtein || client?.targetProtein || 140;
  const clientGoal = client?.goal || 'חיטוב ועיצוב הגוף';

  const prompt = `אתה דיאטן קליני בכיר ומומחה תזונת ספורט ישראלי (העוזר האישי והבוט הרשמי של המאמן אילאי).
תפקידך: לנתח ישירות דרך ה-API כל מאכל, כמות, תיאור חופשי בעברית, סלנג יומיומי או צילום צלחת, לחשב במדויק את הקלוריות והמאקרו המלאים (כולל לחמים, שמנים, ממרחים ורטבים), ולהחזיר משוב פשוט, נגיש, מעודד וסופר-מובן גם לאנשים שלא מבינים כלום בקלוריות ובמאקרו!

פרופיל מתאמן:
- יעד קלורי יומי: ${targetCal} קק״ל
- יעד חלבון: ${targetPro} גרם
- מטרה: ${clientGoal}

תיאור המנה: "${foodQuery}"

דגשים מיוחדים לדיוק מלא והנגשה למתאמנים:
1. חשב את הערכים האמיתיים המלאים בישראל:
   - באגט שלם לבן/צרפתי = 520 קלוריות, 18ג חלבון, 105ג פחמימה. חצי באגט = 260 קלוריות.
   - כריך / באגט חביתה (באגט + 2 ביצים + מיונז + ירקות) = 740-760 קלוריות (34ג חלבון, 105ג פחמימה, 17ג שומן).
   - חביתה מ-2 ביצים = 170 קלוריות (כולל שמן טיגון), 14ג חלבון, 12ג שומן.
   - מריחה של מיונז לייט (15ג) = 40 קלוריות. מיונז רגיל = 100 קלוריות.
   - שווארמה בלאפה עם טחינה וסלטים = 1050 קלוריות, 65ג חלבון, 110ג פחמימה, 39ג שומן.
   - 150 גרם נוטלה = 809 קלוריות, 9.5ג חלבון, 86ג פחמימה, 46.4ג שומן.
   - חזה עוף צלוי = 165 קל', 31ג חלבון ל-100ג.
   - סלמון אפוי = 206 קל', 22.1ג חלבון ל-100ג.
   - אורז מבושל = 130 קל'/100ג. פיתה רגילה = 255 קל'. לאפה = 480 קל'.

2. משפט התובנה של המאמן אילאי (coachInsight):
   - כתוב בשפה חמה, נגישה, ישירה, מעודדת ואותנטית של המאמן אילאי.
   - בלי מונחים טכניים מסובכים.
   - תסביר בפשטות: האם זו מנה טובה לחלבון? כמה קלוריות זה לקח מהיום? ומה לעשות / לאכול בארוחה הבאה בצורה הכי קלה ליישום!
   - אם מדובר בפינוק/חריגה: הסבר ברוגע ובפשטות איך לאזן בקלות בהמשך היום.

החזר אך ורק JSON תקני ומדויק:
{
  "calories": סך קלוריות כמספר שלם,
  "protein": סך חלבון בגרמים,
  "carbs": סך פחמימות בגרמים,
  "fat": סך שומן בגרמים,
  "coachInsight": "משפט תובנה נגיש, מעודד ומעשי מאילאי במילים פשוטות",
  "items": [
    {
      "name": "שם המאכל בשפה ברורה (למשל: 'באגט שלם', 'חביתה מ-2 ביצים')",
      "cal": קלוריות כמספר,
      "pro": חלבון בגרם,
      "carb": פחמימות בגרם,
      "fat": שומן בגרם,
      "swap": "טיפ פשוט או תחליף קליל"
    }
  ]
}`;

  const models = [
    'models/gemini-flash-lite-latest',
    'models/gemini-3.5-flash-lite',
    'models/gemini-3.5-flash',
    'models/gemini-flash-latest'
  ];

  for (const m of models) {
    try {
      const resp = await axios.post(`https://generativelanguage.googleapis.com/v1beta/${m}:generateContent?key=${key}`, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json", temperature: 0.15 }
      }, { timeout: 8000 });
      const txt = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (txt) {
        const match = txt.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          if (parsed && typeof parsed.calories === 'number' && parsed.calories > 10) {
            return parsed;
          }
        }
      }
    } catch(e) {}
  }
  return null;
}

// --- פונקציות עזר למעקב מים, צעדים ותזכורות ---

function parseWaterInput(text) {
  const t = (text || '').trim();
  let amount = 0;
  if (/חצי\s*ליטר/i.test(t)) {
    amount = 500;
  } else if (/שני\s*ליטר|2\s*ליטר/i.test(t)) {
    amount = 2000;
  } else if (/ליטר\s*וחצי|1\.5\s*ליטר/i.test(t)) {
    amount = 1500;
  } else if (/ליטר/i.test(t) && !/חצי/.test(t)) {
    amount = 1000;
  } else {
    const match = t.match(/(\d+)\s*(מ״ל|מל|ml|כוסות|כוס)?/i);
    if (match) {
      const num = parseInt(match[1]);
      if (t.includes('כוס')) amount = num * 250;
      else amount = num;
    }
  }
  return amount;
}

function parseStepsInput(text) {
  const t = (text || '').trim();
  const match = t.match(/(\d[\d,.]*)/);
  if (match) {
    const cleanNum = match[1].replace(/,/g, '');
    return parseInt(cleanNum) || 0;
  }
  return 0;
}

function isWaterQuery(text) {
  const s = (text || '').toLowerCase().trim();
  if (s.startsWith('/water') || s.startsWith('/drink')) return true;
  if (/^(שתיתי|שתית|מים|\+?\d+\s*מ״ל\s*מים|\+?\d+\s*מים)/.test(s) && (s.includes('מים') || s.includes('מ״ל') || s.includes('ליטר') || s.includes('כוס'))) return true;
  return false;
}

function isStepsQuery(text) {
  const s = (text || '').toLowerCase().trim();
  if (s.startsWith('/steps') || s.startsWith('/step') || s.startsWith('/walk')) return true;
  if (/^(הלכתי|עשיתי|צעדתי|צעדים|\+?\d+\s*צעדים)/.test(s) && (s.includes('צעדים') || s.includes('צעד') || s.includes('הליכה'))) return true;
  return false;
}

async function processAndLogWater(chatId, client, amount) {
  const todayDate = new Date().toISOString().split('T')[0];
  if (client.lastTrackedDate !== todayDate) {
    client.dailyWater = 0;
    client.dailySteps = 0;
    client.lastTrackedDate = todayDate;
  }
  client.dailyWater = (client.dailyWater || 0) + amount;
  const target = client.waterTarget || 3000;
  const pct = Math.min(100, Math.round((client.dailyWater / target) * 100));
  const remaining = Math.max(0, target - client.dailyWater);
  const remainingGlasses = Math.ceil(remaining / 250);
  await db.collection('clients').doc(client.id).set(client);
  let reply = '💧 *שתיית מים עודכנה בהצלחה עבור ' + client.name + '!*\n\n';
  reply += '➕ *התווספו:* +' + amount + ' מ״ל\n';
  reply += '📊 *סה״כ להיום:* ' + client.dailyWater + ' / ' + target + ' מ״ל (' + pct + '% מהיעד)\n\n';
  if (client.dailyWater >= target) {
    reply += '🎉 *אלוף! היעד היומי של שתיית המים הושג במלואו! 🏆*';
  } else {
    reply += '🎯 נותרו עוד ' + remaining + ' מ״ל (כ-' + remainingGlasses + ' כוסות) כדי לסגור את היעד!';
  }
  await sendTelegramMessage(chatId, reply);
}

async function processAndLogSteps(chatId, client, stepsCount) {
  const todayDate = new Date().toISOString().split('T')[0];
  if (client.lastTrackedDate !== todayDate) {
    client.dailyWater = 0;
    client.dailySteps = 0;
    client.lastTrackedDate = todayDate;
  }
  client.dailySteps = stepsCount;
  const target = client.stepsTarget || 10000;
  const pct = Math.min(100, Math.round((client.dailySteps / target) * 100));
  const km = (client.dailySteps * 0.00075).toFixed(1);
  const burnedKcal = Math.round(client.dailySteps * 0.04);
  const activeMinutes = Math.round(client.dailySteps / 100);
  await db.collection('clients').doc(client.id).set(client);
  let reply = '👣 *ספירת צעדים עודכנה בהצלחה עבור ' + client.name + '!*\n\n';
  reply += '🚶 *צעדים היום:* ' + client.dailySteps.toLocaleString() + ' / ' + target.toLocaleString() + ' (' + pct + '% מהיעד)\n';
  reply += '📍 *מרחק משוער:* ' + km + ' ק״מ\n';
  reply += '🔥 *שריפת אנרגיה:* ~' + burnedKcal + ' קק״ל\n';
  reply += '⏱️ *זמן הליכה משוער:* ~' + activeMinutes + ' דקות\n\n';
  if (client.dailySteps >= target) {
    reply += '👑 *ניצחון! עמדת ביעד הצעדים היומי בהצלחה מוחצת! 🔥*';
  } else {
    const remSteps = target - client.dailySteps;
    reply += '💪 נשארו עוד ' + remSteps.toLocaleString() + ' צעדים ליעד!';
  }
  await sendTelegramMessage(chatId, reply);
}

function buildReminderMessage(client, type) {
  const name = client.name;
  const phone = (client.phone || '').replace(/\D/g, '').replace(/^0/, '');
  let message = '';
  let title = '';
  switch (type) {
    case 'water':
      title = '💧 תזכורת שתיית מים';
      message = 'היי ' + name + ', תזכורת קטנה לשתות מים! 💧 כמה מים שתית עד עכשיו? שתף אותי או עדכן באפליקציה כדי שנגיע יחד ליעד היומי! 💪';
      break;
    case 'steps':
      title = '👣 תזכורת צעדים ותנועה';
      message = 'היי ' + name + ' 🚶‍♂️ איך הולך עם הצעדים היום? צא לעוד סיבוב קצר של 15 דקות כדי לסגור את היעד היומי. יאללה נותנים בראש! 🔥';
      break;
    case 'food':
      title = '🥑 תזכורת יומן תזונה';
      message = 'היי ' + name + ' 🥗 תזכורת קלה לעדכן את הארוחות שלך במחשבון או לשלוח לי כאן. מעקב עקבי = תוצאות מהירות ובטוחות! 🚀';
      break;
    case 'close':
      title = '🌙 תזכורת סגירת יום וציון';
      message = 'היי ' + name + ' ערב טוב! 🌙 אל תשכח להיכנס לאפליקציה וללחוץ על \'סגירת יום\' כדי לקבל את הציון היומי שלך ולשמור על רצף הימים! 👑';
      break;
    case 'weekend':
      title = '📝 תזכורת שיקוף סופ״ש';
      message = 'היי ' + name + ' שבת שלום! ☀️ תזכורת למלא את שיקוף הסופ״ש והשקילה באפליקציה כדי שנוכל לסכם שבוע מנצח ולדייק את השבוע הבא! 🏆';
      break;
    case 'weigh':
      title = '⚖️ תזכורת שקילה שבועית';
      message = 'היי ' + name + ', בוקר טוב! ☀️ הגיע הזמן לשקילה ומדדים השבועיים שלנו. אשמח שתעדכן אותי בהקדם כדי שנוכל לעקוב ולוודא שאנחנו לגמרי בכיוון הנכון! 💪';
      break;
    default:
      title = '💪 הודעת מעקב כללית';
      message = 'היי ' + name + ', מה קורה? רציתי לראות איך הולך היום ואיך אני יכול לעזור ולדייק אותך כדי שנמשיך הכי חזק שיש!';
  }
  const link = 'https://wa.me/972' + phone + '?text=' + encodeURIComponent(message);
  return { title, message, link };
}