const TRIAGE_PROMPT_INSTRUCTIONS = `
You are a concise medical triage assistant for a demonstration patient-intake application.
Analyze the patient's provided demographic and symptom information and return ONLY one JSON object with exactly these fields:
  - "urgency": one of "red", "yellow", "green"
  - "doctor": a single short medical specialty label
  - "ai_notes": short plain-language triage rationale (maximum about 70 words)

Important:
- Use age and gender when clinically relevant.
- Consider the full symptom description and any other provided patient context.
- Prefer a specific specialty when appropriate; do not default to general physician unless appropriate.
- Do not provide a definitive diagnosis.
- If symptoms suggest a potentially life-threatening emergency, classify as red and recommend immediate emergency evaluation.
- This is an AI-assisted triage demonstration, not a substitute for a clinician.
- Return JSON only. No markdown or additional commentary.

Examples:
1) sudden chest tightness, sweating, pain radiating to left arm, feeling faint
-> {"urgency":"red","doctor":"cardiologist","ai_notes":"Potential acute coronary syndrome; immediate emergency evaluation is warranted."}

2) mild sore throat, runny nose, low fever for 1 day, can eat and drink
-> {"urgency":"green","doctor":"general physician","ai_notes":"Likely a mild respiratory illness; routine clinical follow-up if symptoms worsen or persist."}

3) high fever, fast breathing, child struggling to breathe
-> {"urgency":"red","doctor":"pediatrician","ai_notes":"Respiratory distress with high fever requires urgent pediatric or emergency assessment."}
`;

const TRIAGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    urgency: { type: 'STRING', enum: ['red', 'yellow', 'green'] },
    doctor: { type: 'STRING' },
    ai_notes: { type: 'STRING' }
  },
  required: ['urgency', 'doctor', 'ai_notes'],
  propertyOrdering: ['urgency', 'doctor', 'ai_notes']
};

exports.handler = async (event) => {
  const jsonHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store'
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: jsonHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const name = String(body.name || '').trim();
    const symptoms = String(body.symptoms || '').trim();
    const age = body.age == null || body.age === '' ? null : Number(body.age);
    const gender = String(body.gender || '').trim();
    const address = String(body.address || '').trim();

    if (!symptoms) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Symptoms are required' }) };
    }

    if (age !== null && (!Number.isFinite(age) || age < 0 || age > 130)) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Invalid age' }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured on the server');
    }

    // Send the useful patient context to Gemini. Phone number and patient ID are
    // intentionally excluded because they are not clinically useful for triage.
    const patientContext = [
      `Patient name: ${name || 'not provided'}`,
      `Age: ${age === null ? 'not provided' : age}`,
      `Gender: ${gender || 'not provided'}`,
      `Address: ${address || 'not provided'}`,
      `Symptoms: ${symptoms}`
    ].join('\n');

    const model = 'gemini-3.1-flash-lite';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: TRIAGE_PROMPT_INSTRUCTIONS }]
        },
        contents: [{
          role: 'user',
          parts: [{ text: patientContext }]
        }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: TRIAGE_SCHEMA
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Gemini API error:', response.status, data);
      return {
        statusCode: 502,
        headers: jsonHeaders,
        body: JSON.stringify({ error: 'AI provider request failed', details: data?.error?.message || 'Unknown Gemini error' })
      };
    }

    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) {
      console.error('Gemini returned no text:', JSON.stringify(data).slice(0, 1000));
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'AI returned an empty response' }) };
    }

    let result;
    try {
      result = JSON.parse(rawText);
    } catch (parseError) {
      console.error('Unexpected Gemini output:', rawText.slice(0, 1000));
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: 'AI returned an invalid response' }) };
    }

    if (!['red', 'yellow', 'green'].includes(result.urgency)) result.urgency = 'yellow';
    if (!result.doctor) result.doctor = 'general physician';
    result.ai_notes = String(result.ai_notes || '').slice(0, 400);
    result.raw = rawText;

    return {
      statusCode: 200,
      headers: jsonHeaders,
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('Triage function error:', error.message);
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({ error: 'Unable to complete AI triage' })
    };
  }
};
