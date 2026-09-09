const https = require('https');

// Dedicated Vercel Serverless Function for Food & Vision AI Analysis
module.exports = async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { query, photoBase64, mimeType, clientGoals } = req.body || {};

    if (!query && !photoBase64) {
      return res.status(400).json({ error: 'Missing food query or photo' });
    }

    const key = process.env.GEMINI_API_KEY || Buffer.from('QVEuQWI4Uk42TEVQRWtCdmxJU2o4TWR2eGlsei1QV29UMElqeU45dXNLWkgtTXVIQnBmVHc=', 'base64').toString('utf8');

    const targetCal = clientGoals?.targetCalories || 2000;
    const targetPro = clientGoals?.targetProtein || 140;
    const targetCarb = clientGoals?.targetCarbs || 220;
    const targetFat = clientGoals?.targetFat || 65;
    const targetProCal = clientGoals?.targetProteinCal || Math.round(targetPro * 4);
    const targetCarbCal = clientGoals?.targetCarbsCal || Math.round(targetCarb * 4);
    const targetFatCal = clientGoals?.targetFatCal || Math.round(targetFat * 9);
    const targetFreeCal = clientGoals?.targetFreeCal !== undefined ? clientGoals.targetFreeCal : 150;
    const clientGoal = clientGoals?.goal || 'חיטוב ועיצוב הגוף';

    const prompt = `אתה דיאטן קליני בכיר ומומחה תזונת ספורט ישראלי (העוזר האישי והבוט הרשמי של המאמן אילאי).
תפקידך לנתח בדיוק מירבי כל מאכל, כמות, תיאור בעברית, סלנג ישראלי או צילום צלחת, לחשב את סך הקלוריות והמאקרו המדויק (כולל לחמים, באגטים, שמנים, ממרחים וכל המרכיבים), ולהתאים את הכיסוי למכסות הקלוריות של המתאמן.

פרופיל מכסות קלוריות ויעדים של המתאמן:
- סך יעד קלורי: ${targetCal} קק״ל
- מכסת חלבון: ${targetProCal} קק״ל (${targetPro} גרם)
- מכסת פחמימות: ${targetCarbCal} קק״ל (${targetCarb} גרם)
- מכסת שומן: ${targetFatCal} קק״ל (${targetFat} גרם)
- תקציב קלוריות חופשיות: ${targetFreeCal} קק״ל
- מטרת ליווי: ${clientGoal}

תיאור המנה שהמתאמן הזין:
"${query || (photoBase64 ? "צלחת שצולמה בתמונה" : "")}"

דגשי כיול תזונתי מדויק לישראל (הערך תמיד את המנה המלאה כולל הלחם והשמנים!):
- באגט לבן/צרפתי: באגט שלם = 500-550 קלוריות, 18ג חלבון, 105ג פחמימה. חצי באגט = 250-275 קלוריות.
- כריך / באגט חביתה (באגט שלם + 2 ביצים + מיונז + ירקות): כ-720-750 קלוריות (34ג חלבון, 107ג פחמימה, 17ג שומן).
- חביתה מ-2 ביצים: 160-180 קלוריות (כולל שמן טיגון), 14ג חלבון, 12ג שומן.
- מריחה של מיונז לייט (15ג): 40-45 קלוריות. מיונז רגיל: 95-100 קלוריות.
- שווארמה בלאפה עם טחינה וסלטים: 1050 קלוריות, 65ג חלבון, 110ג פחמימה, 39ג שומן.
- שווארמה בפיתה: 720 קלוריות, 42ג חלבון, 65ג פחמימה, 28ג שומן.
- נוטלה: 539 קל'/100ג (150 גרם נוטלה = 809 קלוריות, 9.5ג חלבון, 86ג פחמימה, 46.4ג שומן).
- חזה עוף צלוי: 165 קל', 31ג חלבון ל-100ג (180ג = 297 קל', 56ג חלבון).
- פילה סלמון אפוי: 206 קל', 22ג חלבון ל-100ג (180ג = 370 קל', 40ג חלבון).
- אורז מבושל: 130 קל'/100ג (כוס מבושלת = 208 קל'). פיתה רגילה: 255 קל'. לאפה: 480 קל'.
- שמן זית: 88 קל' לכף (10ג). טחינה גולמית: 96 קל' לכף (15ג).

משפט התובנה של המאמן אילאי (coachInsight):
כתוב בלשון דיבור חיה, אותנטית, אנרגטית, תומכת ומקצועית של המאמן אילאי.
התייחס במדויק לחלוקה הקלורית מכל מאקרו בארוחה הזו, כמה קלוריות כוסו מתוך כל מכסה קלורית יומית, כמה נותר להיום, ותן טיפ מנצח והנחיה מעשית להמשך היום!

החזר אך ורק JSON תקני ומדויק:
{
  "calories": סך קלוריות כמספר שלם,
  "protein": גרם חלבון,
  "carbs": גרם פחמימה,
  "fat": גרם שומן,
  "proteinCal": קלוריות מחלבון,
  "carbsCal": קלוריות מפחמימה,
  "fatCal": קלוריות משומן,
  "coachInsight": "משפט תובנה ופירגון מקצועי מהמאמן אילאי",
  "items": [
    {
      "name": "שם המאכל וכמות מוערכת בעברית (למשל: 'באגט שלם', 'חביתה מ-2 ביצים')",
      "cal": קלוריות כמספר,
      "pro": חלבון בגרם,
      "carb": פחמימות בגרם,
      "fat": שומן בגרם,
      "swap": "הצעת תחליף איכותי"
    }
  ]
}`;

    const parts = [{ text: prompt }];
    if (photoBase64) {
      parts.push({
        inline_data: {
          mime_type: mimeType || 'image/jpeg',
          data: photoBase64.replace(/^data:image\/[a-z]+;base64,/, '')
        }
      });
    }

    const payload = {
      contents: [{ parts }],
      generationConfig: {
        response_mime_type: 'application/json',
        temperature: 0.1
      }
    };

    const modelsToTry = [
      'models/gemini-flash-lite-latest',
      'models/gemini-3.5-flash-lite',
      'models/gemini-3.5-flash',
      'models/gemini-flash-latest'
    ];

    let resultJson = null;

    for (const mName of modelsToTry) {
      try {
        resultJson = await new Promise((resolve, reject) => {
          const reqAi = https.request({
            hostname: 'generativelanguage.googleapis.com',
            path: `/v1beta/${mName}:generateContent?key=${key}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeout: 9000
          }, (resAi) => {
            let d = '';
            resAi.on('data', c => d += c);
            resAi.on('end', () => {
              if (resAi.statusCode === 200) {
                try {
                  const j = JSON.parse(d);
                  const text = j.candidates?.[0]?.content?.parts?.[0]?.text;
                  if (text) {
                    const match = text.match(/\{[\s\S]*\}/);
                    if (match) {
                      const parsed = JSON.parse(match[0]);
                      if (parsed && typeof parsed.calories === 'number' && parsed.calories > 10) {
                        return resolve(parsed);
                      }
                    }
                  }
                  reject(new Error('Invalid structure'));
                } catch(e) {
                  reject(e);
                }
              } else {
                reject(new Error(`Status ${resAi.statusCode}`));
              }
            });
          });
          reqAi.on('error', reject);
          reqAi.on('timeout', () => { reqAi.destroy(); reject(new Error('Timeout')); });
          reqAi.write(JSON.stringify(payload));
          reqAi.end();
        });

        if (resultJson) break;
      } catch(err) {
        // Continue to next model
      }
    }

    if (!resultJson) {
      return res.status(500).json({ error: 'AI analysis service temporarily unavailable' });
    }

    return res.status(200).json(resultJson);
  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
};
