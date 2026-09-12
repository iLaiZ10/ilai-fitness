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
    await sendTelegramMessage(chatId, "❌ שגיאה: Firebase אינו מוגדר או מחובר כראוי בשרת. אנא הגדר את המשתנה `FIREBASE_SERVICE_ACCOUNT` ב-Vercel.");
    return res.status(200).send('No DB');
  }

  // 4. פענוח פקודות והודעות
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
      // ⚡ זיהוי חופשי של הודעת אוכל / סלנג ללא צורך בפקודה מיוחדת!
      // למשל: "150 גרם נוטלה", "אלירן 150 גרם נוטלה", "באגט חביתה", "אכלתי חזה עוף ואורז"
      const snapshot = await db.collection('clients').where('status', '==', 'active').get();
      const activeClients = [];
      snapshot.forEach(doc => activeClients.push(doc.data()));

      let targetClient = null;
      let foodDesc = text;

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

      // אם לא צוין שם אך יש מתאמן פעיל יחיד במערכת
      if (!targetClient && activeClients.length === 1) {
        targetClient = activeClients[0];
      } else if (!targetClient && activeClients.length > 1 && isLikelyFoodQuery(text)) {
        // ברירת מחדל: המתאמן הפעיל הראשון
        targetClient = activeClients[0];
      }

      if (targetClient && (isLikelyFoodQuery(foodDesc) || isLikelyFoodQuery(text) || foodDesc.length > 2)) {
        await sendTelegramMessage(chatId, `⏳ מנתח ומזין ארוחה עבור *${targetClient.name}*...`);
        const ok = await processAndLogMeal(chatId, targetClient, foodDesc || text);
        if (ok) return res.status(200).send('OK');
      }

      // עזרה והסבר על פקודות
      const helpText = `*🤖 בוט עוזר המאמן - ILAI FITNESS*\n\nהנה הפקודות והאפשרויות:\n\n*🥑 רישום ארוחה חופשי (0 מאמץ):*\n• \`150 גרם נוטלה\`\n• \`אלירן 180 גרם חזה עוף ואורז\`\n• `/food [שם] [מאכל]`\n\n*📋 מידע וניהול מתאמנים:*\n• /list - רשימת המתאמנים הפעילים.\n• /client \`[שם]\` - כרטיס מתאמן.\n• /macros \`[שם] 900 700 250 150\` - עדכון מכסות מאקרו.\n\n*✍️ פעולות מהירות:*\n• /weigh \`[שם] [משקל]\` - עדכון שקילה.\n• /notes \`[שם] [טקסט]\` - הוספת הערה.\n• /done \`[שם]\` - סימון אימון/פגישה.`;
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
    'פרו', 'סלט', 'טוסט', 'גבינה'
  ];
  return foodKeywords.some(kw => s.includes(kw)) && !s.startsWith('/');
}

// ניתוח מאכל עם Gemini ומאגר המזון הישראלי
async function analyzeFoodQueryWithAi(foodQuery, client = null) {
  const key = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42TEVQRWtCdmxJU2o4TWR2eGlsei1QV29UMElqeU45dXNLWkgtTXVIQnBmVHc=', 'base64').toString('utf8');
  
  const targetCal = client?.macroCalculated?.targetCalories || client?.targetCalories || 2000;
  const targetPro = client?.macroCalculated?.targetProtein || client?.targetProtein || 140;
  const targetCarb = client?.macroCalculated?.targetCarbs || client?.targetCarbs || 200;
  const targetFat = client?.macroCalculated?.targetFat || client?.targetFat || 60;
  
  const targetProCal = client?.macroCalculated?.targetProteinCal || client?.targetProteinCal || Math.round(targetPro * 4);
  const targetCarbCal = client?.macroCalculated?.targetCarbsCal || client?.targetCarbsCal || Math.round(targetCarb * 4);
  const targetFatCal = client?.macroCalculated?.targetFatCal || client?.targetFatCal || Math.round(targetFat * 9);
  const targetFreeCal = client?.macroCalculated?.targetFreeCal !== undefined ? client?.macroCalculated?.targetFreeCal : (client?.targetFreeCal || 0);
  
  const clientGoal = client?.goal || 'חיטוב ועיצוב הגוף';

  const prompt = `אתה דיאטן קליני בכיר ומומחה תזונת ספורט ישראלי (העוזר האישי והבוט הרשמי של המאמן אילאי).
תפקידך לנתח בדיוק מירבי כל מאכל, כמות, תיאור בעברית או סלנג ישראלי, לחשב את סך הקלוריות והמאקרו (חלבון×4, פחמימה×4, שומן×9), ולהתאים את הכיסוי למכסות הקלוריות היומיות ותקציב הקלוריות החופשיות של המתאמן.

פרופיל מכסות קלוריות ויעדים:
- סך יעד קלורי: ${targetCal} קק״ל
- מכסת חלבון: ${targetProCal} קק״ל (${targetPro} גרם)
- מכסת פחמימות: ${targetCarbCal} קק״ל (${targetCarb} גרם)
- מכסת שומן: ${targetFatCal} קק״ל (${targetFat} גרם)
- תקציב קלוריות חופשיות (פינוק / גמיש): ${targetFreeCal} קק״ל
- מטרה: ${clientGoal}

תיאור המנה: "${foodQuery}"

כללי כיול תזונתי מדויק לישראל:
- באגט לבן/צרפתי: באגט שלם = 500-550 קלוריות, 18ג חלבון, 105ג פחמימה. חצי באגט = 250-275 קלוריות.
- כריך / באגט חביתה (באגט + 2 ביצים + מיונז + ירקות): כ-720-750 קלוריות (34ג חלבון, 107ג פחמימה, 17ג שומן).
- חביתה מ-2 ביצים: 160-180 קלוריות (כולל שמן טיגון), 14ג חלבון, 12ג שומן.
- מריחה של מיונז לייט (15ג): 40-45 קלוריות. מיונז רגיל: 95-100 קלוריות.
- נוטלה / ממרח שוקולד: 539 קל', 6.3ג' חלבון, 57.5ג' פחמימה, 30.9ג' שומן ל-100 גרם (150 גרם נוטלה = 809 קל', 9.5ג' חלבון, 86ג' פחמימה, 46.4ג' שומן).
- שווארמה בלאפה עם טחינה וסלטים: 1050 קל', 65ג' חלבון (260 קל'), 110ג' פחמימה (440 קל'), 39ג' שומן (351 קל').
- חזה עוף: 165 קל', 31ג' חלבון ל-100ג'.
- סלמון אפוי: 206 קל', 22.1ג' חלבון ל-100ג'.
- ביצה L: 75 קל', 6.8ג' חלבון.
- אורז מבושל: 130 קל'/100ג' (כוס מבושלת 160ג' = 208 קל').
- פיתה רגילה: 255 קל'. פיתה קלה: 99 קל'. לאפה: 480 קל'.
- שמן זית: 88 קל' לכף (10ג'). טחינה גולמית: 96 קל' לכף (15ג').

משפט התובנה של המאמן אילאי (coachInsight):
כתוב בלשון דיבור חיה, אותנטית, אנרגטית, תומכת ומקצועית של המאמן אילאי.
התייחס במדויק לחלוקה הקלורית מכל מאקרו בארוחה הזו (חלבון, פחמימה, שומן), כמה קלוריות כוסו מתוך כל מכסה קלורית יומית, כמה קלוריות נותרו להיום בכל אחת מהמכסות (או אם נוצרה חריגה), האם נוצלו קלוריות מתקציב הקלוריות החופשיות (אם מדובר בפינוק/ממתק/נשנוש), ותן טיפ מנצח ודגש פרקטי מה לאכול בהמשך היום כדי לסגור את היעדים בצורה מושלמת!

החזר אך ורק JSON תקני ומדויק:
{
  "calories": סך קלוריות כמספר שלם,
  "protein": סך חלבון בגרמים,
  "carbs": סך פחמימות בגרמים,
  "fat": סך שומן בגרמים,
  "proteinCal": קלוריות מחלבון כמספר,
  "carbsCal": קלוריות מפחמימה כמספר,
  "fatCal": קלוריות משומן כמספר,
  "coachInsight": "משפט תובנה, פירגון והנחיה אישית ממוקדת מכסות ותקציב חופשי מהמאמן אילאי",
  "items": [
    {
      "name": "שם המאכל וכמות מוערכת בעברית",
      "cal": קלוריות כמספר,
      "pro": חלבון בגרם,
      "carb": פחמימות בגרם,
      "fat": שומן בגרם,
      "swap": "הצעת תחליף שווה ערך איכותי ובריא יותר"
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
        generationConfig: { response_mime_type: "application/json", temperature: 0.1 }
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
