const TRIAGE_API = '/.netlify/functions/triage';
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwfhdh5i24ufnTlM4d-HtOl-fP5xWF_YciQc8kmIXnd6CIEdaM5p9YVhx1gPNTS12FJuw/exec'; // Apps Script web app URL


const $ = id => document.getElementById(id);
const form = $('intakeForm');
const btnSubmit = $('btnSubmit');
const btnClear = $('btnClear');
const llmStatus = $('llmStatus');
const overrideBox = $('override');
const overrideUrgency = $('overrideUrgency');
const overrideDoctor = $('overrideDoctor');
const overrideNotes = $('overrideNotes');
const btnSaveManual = $('btnSaveManual');
const btnCancelManual = $('btnCancelManual');
const patientView = $('patientView');
const patientContent = $('patientContent');
const backFromPatient = $('backFromPatient');
const btnPrint = $('btnPrint');
const listView = $('listView');
const formView = $('formView');
const patientsTableBody = document.querySelector('#patientsTable tbody');
const btnViewAll = $('btnViewAll');
const backFromList = $('backFromList');

const ALLOWED_SPECIALTIES = [
  "general physician","cardiologist","neurologist","pediatrician","gynecologist",
  "pulmonologist","orthopedist","dermatologist","gastroenterologist","endocrinologist",
  "urologist","nephrologist","rheumatologist","otolaryngologist","ophthalmologist",
  "psychiatrist","infectious disease","hematologist","oncologist","vascular surgeon",
  "plastic surgeon","general surgeon","obstetrician","pain specialist","allergist",
  "immunologist","rehabilitation physician","sports medicine","sleep medicine",
  "occupational medicine","palliative care","geriatrics","family physician",
  "clinical pharmacologist","interventional cardiologist","cardiothoracic surgeon",
  "neurosurgeon","addiction medicine","adolescent medicine"
];

const TRIAGE_PROMPT_INSTRUCTIONS = `
You are a concise medical triage assistant. Analyze the patient's short symptom text and return ONLY a single JSON object
with exactly these fields:
  - "urgency": one of "red", "yellow", "green"
  - "doctor": a single short specialty label (e.g., "cardiologist", "dermatologist", "general physician", etc.)
  - "ai_notes": short plain-language triage rationale (max ~70 words)

Guidance:
- Prefer a specific specialty when appropriate (don't default to "general physician" unless necessary).
- You may choose any reasonable specialty label — it does NOT have to be restricted to a short curated list, but prefer named specialties.
- Return JSON only, no extra commentary, no markdown, nothing else.

Examples (INPUT -> OUTPUT):
1) "sudden chest tightness, sweating, radiating pain to left arm, feeling faint"
-> {"urgency":"red","doctor":"cardiologist","ai_notes":"Suspected acute coronary syndrome: chest tightness with arm radiation and diaphoresis — treat as emergency and arrange immediate cardiology evaluation."}

2) "mild sore throat, runny nose, low fever for 1 day, can eat and drink"
-> {"urgency":"green","doctor":"general physician","ai_notes":"Likely mild viral upper respiratory infection; symptomatic care and primary care follow-up if worsening."}

3) "high fever 39C, fast breathing, cough, child struggling to breathe"
-> {"urgency":"red","doctor":"pediatrician","ai_notes":"Child with high fever and respiratory distress — urgent pediatric/ED evaluation required."}

4) "intermittent blood in stool for 2 weeks, weight loss"
-> {"urgency":"yellow","doctor":"gastroenterologist","ai_notes":"Rectal bleeding with weight loss — expedited gastroenterology assessment and colonoscopy indicated."}

5) "blurry vision and floaters in one eye, sudden onset"
-> {"urgency":"yellow","doctor":"ophthalmologist","ai_notes":"Acute visual changes — ophthalmology review recommended to assess retinal detachment or vitreous pathology."}

6) "worsening knee pain after sport injury, swollen and can't fully extend"
-> {"urgency":"yellow","doctor":"orthopedist","ai_notes":"Likely ligament or meniscal injury — orthopedic evaluation and imaging recommended."}

7) "severe right lower abdominal pain with fever and nausea"
-> {"urgency":"red","doctor":"general surgeon","ai_notes":"Symptoms consistent with possible acute appendicitis — urgent surgical assessment recommended."}

8) "progressive fatigue, easy bruising, unexplained anemia on labs"
-> {"urgency":"yellow","doctor":"hematologist","ai_notes":"Lab evidence of cytopenia and systemic symptoms—hematology workup indicated."}
`;

function extractJSONFromText(text){
  if(!text || typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if(start === -1) return null;
  let depth = 0;
  for(let i=start;i<text.length;i++){
    if(text[i] === '{') depth++;
    else if(text[i] === '}'){
      depth--;
      if(depth === 0){
        const candidate = text.slice(start, i+1);
        try { return JSON.parse(candidate); } catch(e){ break; }
      }
    }
  }
  const simple = text.match(/\{[\s\S]*\}/);
  if(simple){
    try { return JSON.parse(simple[0]); } catch(e) {}
  }
  return null;
}

function minimalFallback(symptoms, rawText){
  return {
    urgency: 'yellow',
    doctor: 'general physician',
    ai_notes: `(PARSE_FAIL) Could not parse model output. Raw model text: ${String(rawText).slice(0,300)}`
  };
}

async function callLLM(patient){
  const body = {
    name: String(patient.name || '').trim(),
    age: patient.age === '' || patient.age == null ? null : Number(patient.age),
    gender: String(patient.gender || '').trim(),
    address: String(patient.address || '').trim(),
    symptoms: String(patient.symptoms || '').trim()
  };

  const resp = await fetch(TRIAGE_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const json = await resp.json().catch(() => null);
  if(!resp.ok){
    throw new Error(json?.error || `Triage API HTTP ${resp.status}`);
  }

  if(!json || typeof json !== 'object'){
    throw new Error('Invalid triage API response');
  }

  return {
    urgency: String(json.urgency || 'yellow').trim().toLowerCase(),
    doctor: String(json.doctor || 'general physician').trim(),
    ai_notes: String(json.ai_notes || '').slice(0,400),
    raw: json.raw || JSON.stringify(json)
  };
}

function generatePatientId(){ return `P${Date.now()}-${Math.floor(1000+Math.random()*9000)}`; }

async function saveToSheet(record){
  if(!APPS_SCRIPT_URL || APPS_SCRIPT_URL.includes('REPLACE_WITH')) throw new Error('APPS_SCRIPT_URL not set');
  const maxAttempts = 3;
  let attempt = 0;
  while(attempt < maxAttempts){
    attempt++;
    try {
      const res = await fetch(APPS_SCRIPT_URL, { method:'POST', headers:{'Content-Type':'text/plain'}, body: JSON.stringify(record) });
      if(!res.ok){
        const status = res.status;
        const txt = await res.text().catch(()=>'');
        if(status === 429 || (status >=500 && status <600)){
          const wait = 500 * Math.pow(2, attempt-1);
          console.warn(`saveToSheet attempt ${attempt} got ${status}. Retrying after ${wait}ms.`);
          await new Promise(r=>setTimeout(r, wait));
          continue;
        } else {
          throw new Error(`Apps Script HTTP ${status}: ${txt || res.statusText}`);
        }
      }
      const payload = await res.json().catch(async e => { const raw = await res.text().catch(()=>''); throw new Error('Non-JSON Apps Script response: '+raw); });
      return payload;
    } catch(err){
      const last = attempt >= maxAttempts;
      console.error('saveToSheet error:', err.message);
      if(last) throw new Error(`Failed to save after ${attempt} attempts: ${err.message}`);
      await new Promise(r=>setTimeout(r, 400 * Math.pow(2, attempt-1)));
    }
  }
}

async function fetchAllPatients(){
  try {
    const res = await fetch(APPS_SCRIPT_URL);
    const data = await res.json();
    return data;
  } catch(err){
    throw new Error('Failed to fetch patients: ' + err.message);
  }
}

function setStatus(t){ if(llmStatus) llmStatus.textContent = `AI status: ${t}`; }
function escapeHtml(s){ return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function showPatientPage(p){
  formView.classList.add('hidden'); listView.classList.add('hidden'); patientView.classList.remove('hidden');
  const pillClass = `pill ${p.urgency || 'yellow'}`;
  patientContent.innerHTML = `
    <h2>Patient: ${escapeHtml(p.name||'')} <span style="font-weight:600">(${p.id})</span></h2>
    <div><strong>Age:</strong> ${escapeHtml(p.age||'')} &nbsp; <strong>Gender:</strong> ${escapeHtml(p.gender||'')}</div>
    <div><strong>Phone:</strong> ${escapeHtml(p.phone||'')}</div>
    <div><strong>Address:</strong> ${escapeHtml(p.address||'')}</div>
    <hr/>
    <div><strong>Symptoms:</strong><div style="margin-top:6px">${escapeHtml(p.symptoms||'')}</div></div>
    <div style="margin-top:10px">
      <span class="${pillClass}">${(p.urgency||'').toUpperCase()}</span>
      <span style="margin-left:12px"><strong>Doctor:</strong> ${escapeHtml(p.doctor||'')}</span>
    </div>
    <div style="margin-top:12px"><strong>AI notes:</strong><div style="margin-top:6px">${escapeHtml(p.ai_notes||'')}</div></div>
    <details style="margin-top:12px;color:#666"><summary>Raw AI output</summary><pre style="white-space:pre-wrap">${escapeHtml(p.raw||'')}</pre></details>
  `;
}

function renderPatientsTable(rows){
  patientsTableBody.innerHTML = '';
  if(!Array.isArray(rows)) return;
  rows.slice().reverse().forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(r.id||'')}</td>
      <td>${escapeHtml(r.name||'')}</td>
      <td>${escapeHtml(r.age||'')}</td>
      <td><span class="pill ${r.urgency||'yellow'}">${(r.urgency||'').toUpperCase()}</span></td>
      <td>${escapeHtml(r.doctor||'')}</td>
      <td>${escapeHtml(r.timestamp||'')}</td>
      <td><button class="btn small viewBtn" data-id="${escapeHtml(r.id||'')}">View</button></td>
    `;
    patientsTableBody.appendChild(tr);
  });
  document.querySelectorAll('.viewBtn').forEach(b => b.addEventListener('click', async ev=>{
    const id = ev.currentTarget.dataset.id;
    try { setStatus('fetching...'); const all = await fetchAllPatients(); const found = (all||[]).find(x=>x.id===id); if(found) showPatientPage(found); else alert('Not found'); }
    catch(e){ alert('Error: '+e.message); } finally { setStatus('idle'); }
  }));
}

form.addEventListener('submit', async ev=>{
  ev.preventDefault();
  const fd = new FormData(form);
  const patient = Object.fromEntries(fd.entries());
  patient.symptoms = (patient.symptoms||'').trim();
  if(!patient.symptoms){ alert('Please enter symptoms'); return; }
  patient.id = generatePatientId();
  patient.timestamp = new Date().toISOString();

  setStatus('calling LLM...');
  btnSubmit.disabled = true;
  try {
    const ai = await callLLM(patient);
    setStatus('LLM response received');

    const parseFailed = (ai.ai_notes||'').startsWith('(PARSE_FAIL)') || (ai.ai_notes||'').startsWith('LLM error:');

    const triage = { urgency: ai.urgency||'yellow', doctor: ai.doctor||'general physician', ai_notes: ai.ai_notes||'', raw: ai.raw||'' };

    overrideUrgency.value = triage.urgency;
    overrideDoctor.value = triage.doctor;
    overrideNotes.value = triage.ai_notes;

    showPatientPage({...patient, ...triage});

    if(parseFailed){
      overrideBox.classList.remove('hidden');
      setStatus('AI parse issues — review before saving.');
    } else {
      try { await doSaveRecord({...patient,...triage}); }
      catch(saveErr){ console.error('Auto-save failed', saveErr); overrideBox.classList.remove('hidden'); overrideNotes.value = 'Save failed: '+saveErr.message; alert('Auto-save failed. Please Save to Sheet manually.'); setStatus('idle'); }
    }
  } catch(err){
    console.error('Triage error', err);
    alert('Error: '+err.message);
    overrideBox.classList.remove('hidden');
    overrideNotes.value = 'LLM flow error: '+err.message;
    setStatus('idle');
  } finally { btnSubmit.disabled = false; }
});

btnSaveManual.addEventListener('click', async ()=>{
  const fd = new FormData(form);
  const patient = Object.fromEntries(fd.entries());
  patient.symptoms = (patient.symptoms||'').trim();
  if(!patient.symptoms){ alert('Missing symptoms'); return; }
  patient.id = generatePatientId();
  patient.timestamp = new Date().toISOString();
  patient.urgency = overrideUrgency.value;
  patient.doctor = overrideDoctor.value || 'general physician';
  patient.ai_notes = overrideNotes.value || '';
  patient.raw = patient.ai_notes;
  try { await doSaveRecord(patient); overrideBox.classList.add('hidden'); } catch(e){ alert('Save failed: '+e.message); }
});
btnCancelManual.addEventListener('click', ()=>{ overrideBox.classList.add('hidden'); formView.classList.remove('hidden'); patientView.classList.add('hidden'); });

async function doSaveRecord(record){
  setStatus('saving to sheet...');
  try {
    const res = await saveToSheet(record);
    if(res && res.success){ setStatus('saved'); alert('Saved successfully (ID: '+(record.id||'')+')'); showPatientPage(record); form.reset(); }
    else throw new Error(JSON.stringify(res));
  } catch(err){ setStatus('save failed'); throw err; }
}

btnClear.addEventListener('click', ()=>form.reset());
backFromPatient.addEventListener('click', ()=>{ patientView.classList.add('hidden'); formView.classList.remove('hidden'); });
btnPrint.addEventListener('click', ()=>window.print());
btnViewAll.addEventListener('click', async ()=>{ formView.classList.add('hidden'); patientView.classList.add('hidden'); listView.classList.remove('hidden'); setStatus('loading'); try{ const data = await fetchAllPatients(); renderPatientsTable(Array.isArray(data)?data:[]); setStatus('idle'); }catch(e){ setStatus('idle'); alert('Error: '+e.message); }});
backFromList.addEventListener('click', ()=>{ listView.classList.add('hidden'); formView.classList.remove('hidden'); });

(function init(){ setStatus('idle'); console.log('AI-first specialties: model decides doctor; fallback only on parse failure.'); })();

