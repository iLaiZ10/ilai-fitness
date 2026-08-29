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

  const update = req.body;
  if (!update || !update.message) {
    return res.status(200).send('No message found');
  }

  const message = update.message;
  const chatId = message.chat.id;
  const text = (message.text || '').trim();

  // 1. פקודת /start תמיד מורשית לכולם כדי לגלות את מזהה ה-Chat ID
  if (text.startsWith('/start')) {
    const responseText = `👋 שלום איליי!\n\nהבוט של *ILAI FITNESS* מחובר לענן בהצלחה.\n\n🔑 מזהה ה-Chat ID שלך הוא:\n\`${chatId}\`\n\nהעתק מזהה זה והזן אותו תחת הגדרות הסביבה של Vercel (בשם \`TELEGRAM_ALLOWED_CHAT_ID\`) כדי לאבטח את הבוט.`;
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
    await sendTelegramMessage(chatId, "❌ שגיאה: Firebase אינו מוגדר או מחובר כראוי בשרת. אנא הגדר את המשתנה `FIREBASE_SERVICE_ACCOUNT` ב-Vercel.");
    return res.status(200).send('No DB');
  }

  // 4. פענוח פקודות
  try {
    if (text === '/list') {
      // רשימת לקוחות
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

      // הצגת נתוני לקוח
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
      // עדכון שקילה: /weigh אלירן 85.2
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

      // הוספת שקילה
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
      client.needsAttention = false; // משקל תקין מנקה התראת קושי

      await db.collection('clients').doc(client.id).set(client);
      await sendTelegramMessage(chatId, `⚖️ שקילה עודכנה בהצלחה!\n\n👤 מתאמן: *${client.name}*\n📅 תאריך: ${todayDate}\n📈 משקל: *${weightVal} ק״ג*`);
    }
    else if (text.startsWith('/notes')) {
      // הוספת הערה: /notes אלירן מרגיש עייף השבוע
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
    else if (text.startsWith('/done')) {
      // סיום פגישה שבועית: /done אלירן
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

      // חיפוש פגישה מתוזמנת קרובה ביומן
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
    }
    else {
      // עזרה והסבר על פקודות
      const helpText = `*🤖 בוט עוזר המאמן - ILAI FITNESS*\n\nהנה הפקודות שתוכל לשלוח לי:\n\n*📋 מידע וניהול לקוחות:*\n• /list - הצגת כל המתאמנים הפעילים.\n• /client \`[שם]\` - פרטים של מתאמן ספציפי.\n\n*✍️ ביצוע שינויים מהירים:*\n• /weigh \`[שם] [משקל]\` - הוספת שקילה חדשה לענן.\n• /notes \`[שם] [טקסט]\` - הוספת הערה/דגש לכרטיס לקוח.\n• /done \`[שם]\` - סמן פגישה/אימון מתוזמן כ"בוצע".`;
      await sendTelegramMessage(chatId, helpText);
    }
  } catch (error) {
    console.error(error);
    await sendTelegramMessage(chatId, `❌ שגיאה בביצוע הפקודה: ${error.message}`);
  }

  return res.status(200).send('OK');
};

// פונקציית עזר למציאת לקוח לפי שם חלקי
async function findClientByName(queryName) {
  const snapshot = await db.collection('clients').get();
  let found = null;
  snapshot.forEach(doc => {
    const c = doc.data();
    if (c.name.toLowerCase().includes(queryName)) {
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
