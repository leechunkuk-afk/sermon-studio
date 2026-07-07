/* ═══════════════════════════════════════════════════════════════
   설교 스튜디오 — 부서(에이전트) 파이프라인 오케스트레이션
   흐름: 주제 입력 → 각 조사 부서 LLM 순차 호출 → 결과 메모리 저장
        → 편집국이 전체 보고서를 통합해 설교문 초안 작성
   ═══════════════════════════════════════════════════════════════ */

// ─────────── 기본 부서 정의 ───────────
const COMMON_RULES = `
[공통 규칙]
- 반드시 한국어로 작성합니다.
- 당신이 아는 지식 안에서 답하되, 확실하지 않은 사실(연도·수치·인용)은 "확인 필요"라고 표시합니다.
- 출처나 인물을 지어내지 않습니다. 기억이 불확실하면 그렇다고 밝힙니다.
- 개조식(불릿) 마크다운으로 보고서를 작성합니다.`;

const DEFAULT_DEPTS = [
  {
    id: "original-lang", icon: "🔤", name: "원어연구부", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [원어연구부] 연구원입니다. 히브리어·헬라어 성경 원어 전문가입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

본문(본문이 없으면 주제와 관련된 대표 본문을 선정)의 원어를 연구해 보고서를 작성하세요.
- 핵심 단어 2~4개의 원어 분석: 원형(히브리어/헬라어 표기 + 한글 음역), 기본 뜻, 뉘앙스, 같은 단어가 쓰인 다른 본문
- 시제·태·문법 구조가 드러내는 의미 (예: 미완료형이 보여주는 계속성)
- 번역본(개역개정 등)에서 놓치기 쉬운 원어의 풍성한 의미
- 각 원어 포인트를 설교에서 풀어 설명하는 방법 제안` + COMMON_RULES,
  },
  {
    id: "social", icon: "🗞️", name: "사회이슈부", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [사회이슈부] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제와 연결되는 현대 사회의 이슈를 조사해 보고서를 작성하세요.
- 이 주제가 오늘날 성도들의 삶과 맞닿는 지점 3~5가지
- 관련된 사회 현상, 통계적 경향, 세대별 고민
- 설교에 연결할 수 있는 적용점 제안` + COMMON_RULES,
  },
  {
    id: "history", icon: "📜", name: "역사자료부", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [역사자료부] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제와 관련된 역사 자료를 조사해 보고서를 작성하세요.
- 교회사 속 관련 사건·인물 (초대교회, 종교개혁, 한국교회사 등)
- 본문의 역사적·문화적 배경 (당시 시대상, 지리, 관습)
- 일반 세계사에서 참고할 만한 사례` + COMMON_RULES,
  },
  {
    id: "foreign", icon: "🌍", name: "해외자료부", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [해외자료부] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제에 대한 해외 자료를 조사해 보고서를 작성하세요.
- 해외 유명 설교자·신학자들이 이 주제를 다룬 관점 (스펄전, 팀 켈러, 존 스토트 등)
- 해외 주석과 신학 문헌의 주요 해석
- 한국 교회 상황에 맞게 소개할 때 주의할 점` + COMMON_RULES,
  },
  {
    id: "korean", icon: "⛪", name: "국내설교부", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [국내설교부] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제에 대한 국내 설교 경향을 조사해 보고서를 작성하세요.
- 한국 교회에서 이 주제가 주로 다뤄지는 방식과 대표적 접근
- 자주 쓰이는 설교 구조(3대지, 강해, 이야기식 등) 중 이 주제에 맞는 형식 제안
- 한국 성도들의 정서에 맞는 표현과 피해야 할 상투적 표현` + COMMON_RULES,
  },
  {
    id: "illu-acad", icon: "🔬", name: "예화부 (학술·과학)", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [예화부 — 학술·과학 분과] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제를 뒷받침할 학술·과학 예화를 발굴해 보고서를 작성하세요.
- 관련된 과학 현상, 심리학·사회학 연구 결과 2~3가지
- 각 예화를 설교에서 풀어내는 방법 (도입/전개/결론 어디에 적합한지)
- 과학적 정확성에 대한 주의 사항` + COMMON_RULES,
  },
  {
    id: "illu-classic", icon: "📚", name: "예화부 (인문·고전)", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [예화부 — 인문·고전 분과] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제를 뒷받침할 인문·고전 예화를 발굴해 보고서를 작성하세요.
- 관련된 문학 작품, 철학자의 통찰, 명언 2~3가지
- 전래동화·전승·설화·고전 이야기 중 연결 가능한 것 1~2가지
- 각 예화의 핵심 메시지와 설교 주제의 연결 고리` + COMMON_RULES,
  },
  {
    id: "illu-sns", icon: "📱", name: "예화부 (SNS·트렌드)", enabled: true, type: "research",
    prompt: `당신은 교회 설교 준비팀의 [예화부 — SNS·트렌드 분과] 연구원입니다.
설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

이 주제와 연결되는 현대인의 일상·트렌드 예화를 발굴해 보고서를 작성하세요.
- SNS·미디어 문화에서 볼 수 있는 관련 현상 (비교 문화, 인증 문화, 짧은 콘텐츠 소비 등)
- 젊은 세대가 공감할 만한 일상 속 장면 2~3가지
- 세대 통합적으로 쓸 수 있는 표현 방법` + COMMON_RULES,
  },
  {
    id: "editor", icon: "✍️", name: "편집국 (종합)", enabled: true, type: "synth",
    prompt: `당신은 교회 설교 준비팀의 [편집국장]입니다. 아래는 각 부서가 제출한 조사 보고서입니다.

설교 주제: {topic}
본문 말씀: {scripture}
추가 지시: {extra}

━━━━━ 부서 보고서 ━━━━━
{reports}
━━━━━━━━━━━━━━━━━

위 보고서들을 통합하여 완성도 높은 설교문 초안을 작성하세요.

[작성 지침]
1. 구조: 제목 → 본문 말씀 → 도입(청중의 삶과 맞닿는 이야기) → 본론(2~3개 대지, 각 대지마다 본문 해석 + 예화 + 적용) → 결론(결단 촉구) → 마무리 기도문
2. 부서 보고서의 자료 중 가장 적합한 것만 선별해 자연스럽게 녹여냅니다. 나열하지 않습니다.
3. 실제 강단에서 말하듯 자연스러운 구어체 존댓말로 작성합니다.
4. "확인 필요"로 표시된 자료는 사용하지 않거나, 사용 시 각주로 [확인 필요]를 남깁니다.
5. 전체 분량은 실제 설교 25~30분 분량을 목표로 합니다.
6. 반드시 한국어로, 마크다운 형식으로 작성합니다.`,
  },
];

// 부서별 기본 웹 검색어 템플릿 ({topic}, {scripture} 치환)
const DEFAULT_SEARCHQ = {
  "original-lang": "{scripture} 원어 주해 히브리어 헬라어",
  social: "{topic} 최근 사회 이슈 뉴스",
  history: "{topic} 역사적 배경 교회사",
  foreign: "{topic} sermon illustration",
  korean: "{topic} 설교",
  "illu-acad": "{topic} 심리학 과학 연구 결과",
  "illu-classic": "{topic} 고전 문학 설화 예화",
  "illu-sns": "{topic} SNS 트렌드 세대 문화",
};
for (const d of DEFAULT_DEPTS) {
  if (d.type === "research") {
    d.webSearch = true;
    d.searchQuery = DEFAULT_SEARCHQ[d.id] || "{topic}";
  }
}

// ─────────── 엔진 프리셋 ───────────
// protocol: 서버가 이해하는 호출 방식 (ollama / openai / anthropic / demo)
// safetensors 모델은 LM Studio·MLX·vLLM 등 엔진이 OpenAI 호환 API로 서빙합니다.
const ENGINE_PRESETS = {
  ollama:     { protocol: "ollama",    baseUrl: "http://localhost:11434", needsKey: false,
                hint: "터미널에서 `ollama serve` 실행 후 ⟳를 누르세요." },
  lmstudio:   { protocol: "openai",    baseUrl: "http://localhost:1234/v1", needsKey: false,
                hint: "LM Studio 앱 → 개발자(Developer) 탭 → Start Server 후 ⟳. safetensors(MLX)·GGUF 모델 지원." },
  mlx:        { protocol: "openai",    baseUrl: "http://localhost:10240/v1", needsKey: false,
                hint: "폴더의 `MLX 모델서버 시작.command`를 더블클릭해 HuggingFace safetensors 모델을 띄운 뒤 ⟳." },
  llamacpp:   { protocol: "openai",    baseUrl: "http://localhost:8080/v1", needsKey: false,
                hint: "llama-server -m 모델.gguf 로 서버 실행 후 ⟳." },
  vllm:       { protocol: "openai",    baseUrl: "http://localhost:8000/v1", needsKey: false,
                hint: "vLLM 서버 (safetensors 지원, 리눅스/GPU 권장)." },
  textgen:    { protocol: "openai",    baseUrl: "http://localhost:5000/v1", needsKey: false,
                hint: "text-generation-webui의 OpenAI 호환 API." },
  koboldcpp:  { protocol: "openai",    baseUrl: "http://localhost:5001/v1", needsKey: false,
                hint: "KoboldCpp 서버." },
  anthropic:  { protocol: "anthropic", baseUrl: "", needsKey: true,
                hint: "Anthropic API 키를 입력하세요." },
  openai:     { protocol: "openai",    baseUrl: "https://api.openai.com/v1", needsKey: true,
                hint: "OpenAI API 키를 입력하세요." },
  gemini:     { protocol: "openai",    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true,
                hint: "Google AI Studio에서 발급한 API 키를 입력하세요." },
  groq:       { protocol: "openai",    baseUrl: "https://api.groq.com/openai/v1", needsKey: true,
                hint: "Groq API 키를 입력하세요 (무료 티어 있음, 매우 빠름)." },
  openrouter: { protocol: "openai",    baseUrl: "https://openrouter.ai/api/v1", needsKey: true,
                hint: "OpenRouter API 키 하나로 수백 개 모델 사용." },
  custom:     { protocol: "openai",    baseUrl: "", needsKey: false,
                hint: "OpenAI 호환 서버 주소를 직접 입력하세요 (예: http://다른PC:1234/v1)." },
  demo:       { protocol: "demo",      baseUrl: "", needsKey: false,
                hint: "데모 모드: LLM 없이 UI 흐름을 시험합니다." },
};

// ─────────── 상태 ───────────
const LS_KEY = "sermon-studio-v1";
let state = {
  settings: {
    enginePreset: "ollama",
    provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "", defaultModel: "",
    webSearch: true, deepFetch: true, runMode: "seq", theme: "dark",
  },
  depts: JSON.parse(JSON.stringify(DEFAULT_DEPTS)),
  positions: {},   // deptId -> {x,y}
  results: {},     // deptId -> {status:'idle'|'running'|'done'|'error', text, ms, model}
  history: [],     // {ts, topic, scripture, final, reports:{id:{name,text}}}
};
let running = false;
let abortRequested = false;
let selectedDept = null;
let activeTab = "final";
let finalMarkdown = "";
let editingDeptId = null;

const $ = (sel) => document.querySelector(sel);
const canvas = $("#canvas");
const wires = $("#wires");

// ─────────── 저장/복원 ───────────
function persist() {
  const { results, ...rest } = state;
  localStorage.setItem(LS_KEY, JSON.stringify(rest));
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_KEY));
    if (!saved) return;
    if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
    // 구버전 저장본: enginePreset 없이 provider만 있던 시절 → 프리셋으로 매핑
    if (!ENGINE_PRESETS[state.settings.enginePreset]) {
      const p = state.settings.provider;
      state.settings.enginePreset =
        p === "ollama" ? "ollama" : p === "anthropic" ? "anthropic" : p === "demo" ? "demo" : "custom";
    }
    state.settings.provider = ENGINE_PRESETS[state.settings.enginePreset].protocol;
    if (saved.depts && saved.depts.length) state.depts = migrateDepts(saved.depts);
    if (saved.positions) state.positions = saved.positions;
    if (saved.history) state.history = saved.history;
  } catch (e) { /* 손상된 저장본은 무시 */ }
}

// 기존 사용자의 저장본에 새 기본 부서·필드를 병합 (업그레이드 마이그레이션)
function migrateDepts(saved) {
  for (const def of DEFAULT_DEPTS) {
    if (saved.some((d) => d.id === def.id)) continue;
    const copy = JSON.parse(JSON.stringify(def));
    const synthIdx = saved.findIndex((d) => d.type === "synth");
    if (copy.type !== "synth" && synthIdx >= 0) saved.splice(synthIdx, 0, copy);
    else saved.push(copy);
  }
  for (const d of saved) {
    if (d.type !== "research") continue;
    if (d.webSearch === undefined) d.webSearch = true;
    if (d.searchQuery === undefined) d.searchQuery = DEFAULT_SEARCHQ[d.id] || "{topic}";
  }
  return saved;
}

// ─────────── 노드 배치 ───────────
function defaultLayout() {
  const pos = { __topic: { x: 30, y: 260 } };
  const research = state.depts.filter((d) => d.type === "research");
  const synth = state.depts.find((d) => d.type === "synth");
  const colX = [320, 580];
  research.forEach((d, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    pos[d.id] = { x: colX[col], y: 40 + row * 150 };
  });
  if (synth) pos[synth.id] = { x: 880, y: 240 };
  return pos;
}
function getPos(id) {
  return state.positions[id] || defaultLayout()[id] || { x: 100, y: 100 };
}

// ─────────── 노드 렌더링 ───────────
function statusInfo(id) {
  const r = state.results[id];
  if (!r) return { cls: "idle", label: "대기 중" };
  if (r.status === "running") return { cls: "running", label: "조사 중…" };
  if (r.status === "done") return { cls: "done", label: `완료 (${(r.ms / 1000).toFixed(1)}초)` };
  if (r.status === "error") return { cls: "error", label: "오류" };
  return { cls: "idle", label: "대기 중" };
}

function renderNodes() {
  canvas.querySelectorAll(".node").forEach((n) => n.remove());

  // 입력 노드 (주제)
  const topicNode = document.createElement("div");
  topicNode.className = "node input-node";
  topicNode.dataset.id = "__topic";
  const p = getPos("__topic");
  topicNode.style.left = p.x + "px";
  topicNode.style.top = p.y + "px";
  topicNode.innerHTML = `
    <div class="node-head"><span class="node-icon">💡</span><span class="node-title">주제 입력</span></div>
    <div class="node-body"><div class="node-preview">${escapeHtml($("#topic").value || "사이드바에서 주제를 입력하세요")}</div></div>`;
  canvas.appendChild(topicNode);
  makeDraggable(topicNode);

  for (const d of state.depts) {
    const el = document.createElement("div");
    const st = statusInfo(d.id);
    el.className = `node ${d.type === "synth" ? "hub" : ""} ${d.enabled ? "" : "disabled"} ${st.cls === "idle" ? "" : st.cls}`;
    if (selectedDept === d.id) el.classList.add("selected");
    el.dataset.id = d.id;
    const pos = getPos(d.id);
    el.style.left = pos.x + "px";
    el.style.top = pos.y + "px";
    const preview = state.results[d.id]?.text
      ? escapeHtml(state.results[d.id].text.slice(0, 90)) + "…"
      : escapeHtml(d.prompt.split("\n").slice(2, 4).join(" ").slice(0, 70));
    el.innerHTML = `
      <div class="node-head">
        <span class="node-icon">${d.icon}</span>
        <span class="node-title">${escapeHtml(d.name)}</span>
        <button class="node-edit" title="부서 편집">✎</button>
      </div>
      <div class="node-body">
        <div class="node-status"><span class="dot ${st.cls}"></span>${st.label}${d.model ? ` · ${escapeHtml(d.model)}` : ""}${state.settings.webSearch && d.webSearch && d.type === "research" ? " · 🔍" : ""}</div>
        <div class="node-preview">${preview}</div>
      </div>`;
    canvas.appendChild(el);
    makeDraggable(el);
    el.querySelector(".node-edit").addEventListener("click", (e) => {
      e.stopPropagation();
      openModal(d.id);
    });
  }
  drawWires();
}

function drawWires() {
  wires.innerHTML = "";
  const synth = state.depts.find((d) => d.type === "synth");
  const research = state.depts.filter((d) => d.type === "research");
  const nodeEl = (id) => canvas.querySelector(`.node[data-id="${id}"]`);

  function port(id, side) {
    const el = nodeEl(id);
    if (!el) return null;
    const x = el.offsetLeft, y = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
    return side === "out" ? [x + w, y + h / 2] : [x, y + h / 2];
  }
  function wire(fromId, toId, active) {
    const a = port(fromId, "out"), b = port(toId, "in");
    if (!a || !b) return;
    const dx = Math.max(40, (b[0] - a[0]) / 2);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${a[0]} ${a[1]} C ${a[0] + dx} ${a[1]}, ${b[0] - dx} ${b[1]}, ${b[0]} ${b[1]}`);
    if (active) path.classList.add("active");
    wires.appendChild(path);
  }
  for (const d of research) {
    if (!d.enabled) continue;
    wire("__topic", d.id, state.results[d.id]?.status === "running");
    if (synth && synth.enabled) wire(d.id, synth.id, state.results[synth.id]?.status === "running");
  }
  if (research.every((d) => !d.enabled) && synth && synth.enabled) wire("__topic", synth.id, false);
}

// ─────────── 드래그 ───────────
function makeDraggable(el) {
  let sx, sy, ox, oy, moved = false;
  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".node-edit")) return;
    sx = e.clientX; sy = e.clientY;
    ox = el.offsetLeft; oy = el.offsetTop;
    moved = false;
    el.setPointerCapture(e.pointerId);
    const onMove = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      el.style.left = Math.max(0, ox + dx) + "px";
      el.style.top = Math.max(0, oy + dy) + "px";
      drawWires();
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      state.positions[el.dataset.id] = { x: el.offsetLeft, y: el.offsetTop };
      persist();
      if (!moved && el.dataset.id !== "__topic") {
        selectedDept = el.dataset.id;
        activeTab = "report";
        syncTabs();
        renderNodes();
        renderPanel();
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
  });
}

// ─────────── LLM 호출 ───────────
const DEMO_TEXTS = {
  research: (name, topic) => `## ${name} 데모 보고서\n\n**주제: ${topic}**\n\n- 데모 모드에서 생성된 예시 항목입니다. 실제 LLM을 연결하면 이 자리에 조사 결과가 들어갑니다.\n- 관련 자료 예시 1: 주제와 연결되는 배경 설명 *(확인 필요)*\n- 관련 자료 예시 2: 설교 적용점 제안\n\n> 데모 모드는 UI 흐름을 시험하기 위한 것입니다. 사이드바에서 Ollama 또는 API를 설정하세요.`,
  synth: (topic) => `# ${topic}\n\n**본문: (데모)**\n\n## 들어가며\n\n사랑하는 성도 여러분, 오늘 우리는 "${topic}"라는 주제 앞에 서 있습니다. 이것은 데모 모드로 생성된 예시 설교문 초안입니다.\n\n## 첫째, 말씀이 보여주는 것\n\n각 부서의 보고서가 이 자리에 통합되어 실제 설교문이 작성됩니다.\n\n## 둘째, 우리 삶에 적용하기\n\n실제 LLM(Ollama 로컬 모델 또는 Claude/OpenAI API)을 연결하면 예화와 적용이 담긴 완성된 초안이 생성됩니다.\n\n## 마무리 기도\n\n주님, 이 도구를 통해 말씀을 준비하는 모든 과정을 인도해 주옵소서. 아멘.`,
};

// 부서 전용 웹 검색: 검색어 템플릿 치환 → /api/search → 프롬프트용 블록 생성
async function webSearchFor(dept, vars) {
  const q = (dept.searchQuery || "{topic}")
    .replaceAll("{topic}", vars.topic)
    .replaceAll("{scripture}", vars.scripture || vars.topic)
    .trim();
  try {
    const res = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, max: 6, fetchPages: state.settings.deepFetch ? 2 : 0 }),
    });
    const out = await res.json();
    if (out.error || !out.results || !out.results.length) return null;
    let block = `[검색어] ${q}\n`;
    out.results.forEach((r, i) => {
      block += `\n${i + 1}. ${r.title}\n   출처: ${r.url}\n   ${r.snippet}`;
      if (r.content) block += `\n   [페이지 본문 발췌] ${r.content}`;
      block += "\n";
    });
    // 로컬 엔진의 컨텍스트 한도를 넘지 않도록 검색 블록 길이 제한
    if (block.length > 4500) block = block.slice(0, 4500) + "\n…(검색 자료 일부 생략)";
    return { query: q, block };
  } catch (e) {
    return null; // 검색 실패 시 검색 없이 진행
  }
}

async function callDept(dept, vars, web) {
  const s = state.settings;
  if (s.provider === "demo") {
    await new Promise((r) => setTimeout(r, 900));
    return dept.type === "synth" ? DEMO_TEXTS.synth(vars.topic) : DEMO_TEXTS.research(dept.name, vars.topic);
  }
  let prompt = dept.prompt
    .replaceAll("{topic}", vars.topic)
    .replaceAll("{scripture}", vars.scripture || "(지정 안 함)")
    .replaceAll("{extra}", vars.extra || "(없음)")
    .replaceAll("{reports}", vars.reports || "");
  if (web) {
    prompt += `

━━━━━ 실시간 웹 검색 결과 ━━━━━
${web.block}
━━━━━━━━━━━━━━━━━
[웹 자료 활용 규칙]
- 위 검색 결과 중 주제와 관련 있는 것을 우선 활용하고, 활용한 내용에는 반드시 출처 URL을 함께 표기하세요.
- 주제와 무관하거나 신뢰하기 어려운 결과는 무시하세요.
- 검색 결과와 당신의 지식이 충돌하면 그 사실을 명시하세요.`;
  }
  const res = await fetch("/api/llm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      provider: s.provider,
      baseUrl: s.baseUrl,
      apiKey: s.apiKey,
      model: dept.model || s.defaultModel,
      system: "당신은 한국 교회 설교 준비를 돕는 전문 연구원입니다. 반드시 한국어로 답합니다.",
      prompt,
      temperature: dept.type === "synth" ? 0.8 : 0.7,
    }),
  });
  const out = await res.json();
  if (out.error) throw new Error(out.error);
  // 추론(reasoning) 모델의 <think> 블록과 특수 토큰 제거
  return (out.text || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/<\|im_end\|>|<\|endoftext\|>|<\|eot_id\|>|\[\|endofturn\|\]/g, "")
    .trim();
}

// ─────────── 파이프라인 실행 ───────────
async function runPipeline() {
  const topic = $("#topic").value.trim();
  if (!topic) { $("#runStatus").textContent = "⚠ 설교 주제를 먼저 입력하세요."; return; }
  if (state.settings.provider !== "demo" && !state.settings.defaultModel && state.depts.some((d) => d.enabled && !d.model)) {
    $("#runStatus").textContent = "⚠ 기본 모델을 설정하세요 (또는 데모 모드 선택).";
    return;
  }

  running = true; abortRequested = false;
  $("#runBtn").disabled = true;
  $("#stopBtn").style.display = "block";
  state.results = {};
  finalMarkdown = "";
  const vars = { topic, scripture: $("#scripture").value.trim(), extra: $("#extra").value.trim() };
  const research = state.depts.filter((d) => d.type === "research" && d.enabled);
  const synth = state.depts.find((d) => d.type === "synth" && d.enabled);
  const memory = []; // 부서별 보고서 메모리

  // 부서 하나 실행: (웹 검색 →) LLM 호출 → 결과 저장. 실패해도 null 반환하고 계속.
  async function runResearchDept(d, label) {
    state.results[d.id] = { status: "running" };
    renderNodes();
    const t0 = performance.now();
    try {
      let web = null;
      if (state.settings.webSearch && d.webSearch && state.settings.provider !== "demo") {
        if (label) $("#runStatus").textContent = `${label} 🔍 웹 검색 중…`;
        web = await webSearchFor(d, vars);
      }
      if (abortRequested) throw new Error("사용자 중단");
      if (label) $("#runStatus").textContent = `${label} 조사 중…`;
      const text = await callDept(d, vars, web);
      state.results[d.id] = {
        status: "done", text, ms: performance.now() - t0,
        model: d.model || state.settings.defaultModel, web: web ? web.query : null,
      };
      renderNodes();
      return { id: d.id, name: d.name, text };
    } catch (e) {
      state.results[d.id] = { status: "error", text: "오류: " + e.message, ms: performance.now() - t0 };
      renderNodes();
      if (e.message === "사용자 중단") throw e;
      return null; // 한 부서가 실패해도 나머지는 계속 진행
    }
  }

  try {
    if (state.settings.runMode === "par") {
      // 병렬 실행: 전 부서 동시 가동
      let done = 0;
      $("#runStatus").textContent = `전 부서 병렬 가동 중… (0/${research.length})`;
      const settled = await Promise.all(
        research.map((d) =>
          runResearchDept(d, null).then((r) => {
            done++;
            $("#runStatus").textContent = `전 부서 병렬 가동 중… (${done}/${research.length})`;
            return r;
          })
        )
      );
      for (const r of settled) if (r) memory.push(r);
    } else {
      // 순차 실행 (기본)
      for (let i = 0; i < research.length; i++) {
        if (abortRequested) throw new Error("사용자 중단");
        const label = `(${i + 1}/${research.length + (synth ? 1 : 0)}) ${research[i].name}`;
        const r = await runResearchDept(research[i], label);
        if (r) memory.push(r);
      }
    }

    if (synth) {
      if (abortRequested) throw new Error("사용자 중단");
      $("#runStatus").textContent = `편집국이 설교문을 작성 중…`;
      state.results[synth.id] = { status: "running" };
      renderNodes();
      // 부서 보고서가 너무 길면 편집국 요청이 로컬 엔진의 컨텍스트 한도를 넘으므로 부서당 길이 제한
      const reports = memory.map((m) => {
        const t = m.text.length > 2400 ? m.text.slice(0, 2400) + "\n…(보고서 일부 생략)" : m.text;
        return `### [${m.name}] 보고서\n${t}`;
      }).join("\n\n---\n\n");
      const t0 = performance.now();
      const text = await callDept(synth, { ...vars, reports });
      state.results[synth.id] = { status: "done", text, ms: performance.now() - t0, model: synth.model || state.settings.defaultModel };
      finalMarkdown = text;
    }

    $("#runStatus").textContent = "✅ 완료! 오른쪽 패널에서 설교문을 확인하세요.";
    // 기록 저장
    state.history.unshift({
      ts: Date.now(), topic, scripture: vars.scripture, final: finalMarkdown,
      reports: Object.fromEntries(memory.map((m) => [m.id, { name: m.name, text: m.text }])),
    });
    state.history = state.history.slice(0, 30);
    persist();
    renderHistory();
    activeTab = "final";
    syncTabs();
  } catch (e) {
    $("#runStatus").textContent = e.message === "사용자 중단" ? "⏹ 중단되었습니다." : "❌ 오류: " + e.message;
  } finally {
    running = false;
    $("#runBtn").disabled = false;
    $("#stopBtn").style.display = "none";
    renderNodes();
    renderPanel();
  }
}

// ─────────── 결과 패널 ───────────
function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
}
function renderPanel() {
  const el = $("#panel-content");
  if (activeTab === "final") {
    if (!finalMarkdown) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">📖</div><p>주제를 입력하고 <b>전체 부서 가동</b>을 누르면<br>각 부서가 자료를 조사하고<br>편집국이 설교문 초안을 작성합니다.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="md">${renderMd(finalMarkdown)}</div>`;
  } else {
    const d = state.depts.find((x) => x.id === selectedDept);
    const r = selectedDept && state.results[selectedDept];
    if (!d || !r || !r.text) {
      el.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div><p>캔버스에서 부서 노드를 클릭하면<br>그 부서의 보고서가 여기 표시됩니다.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="report-meta">${d.icon} ${escapeHtml(d.name)} · ${r.model ? escapeHtml(r.model) : ""} ${r.ms ? "· " + (r.ms / 1000).toFixed(1) + "초" : ""}${r.web ? " · 🔍 " + escapeHtml(r.web) : ""}</div><div class="md">${renderMd(r.text)}</div>`;
  }
}
function currentPanelText() {
  if (activeTab === "final") return finalMarkdown;
  const r = selectedDept && state.results[selectedDept];
  return (r && r.text) || "";
}

// ─────────── 미니 마크다운 렌더러 ───────────
function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inlineMd(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}
function renderMd(src) {
  const lines = escapeHtml(src).split("\n");
  let html = "", listType = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inlineMd(para.join("<br>"))}</p>`; para = []; } };
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  for (const line of lines) {
    const t = line.trim();
    let m;
    if ((m = t.match(/^(#{1,3})\s+(.*)/))) { flushPara(); closeList(); html += `<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`; }
    else if (/^(-{3,}|━+)$/.test(t)) { flushPara(); closeList(); html += "<hr>"; }
    else if ((m = t.match(/^&gt;\s?(.*)/))) { flushPara(); closeList(); html += `<blockquote>${inlineMd(m[1])}</blockquote>`; }
    else if ((m = t.match(/^[-*]\s+(.*)/))) { flushPara(); if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inlineMd(m[1])}</li>`; }
    else if ((m = t.match(/^\d+[.)]\s+(.*)/))) { flushPara(); if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; } html += `<li>${inlineMd(m[1])}</li>`; }
    else if (t === "") { flushPara(); closeList(); }
    else para.push(t);
  }
  flushPara(); closeList();
  return html;
}

// ─────────── 작업 기록 ───────────
function renderHistory() {
  const el = $("#history");
  if (!state.history.length) { el.innerHTML = `<div style="font-size:11px;color:var(--text-dim)">아직 기록이 없습니다</div>`; return; }
  el.innerHTML = "";
  state.history.forEach((h, i) => {
    const item = document.createElement("div");
    item.className = "history-item";
    const d = new Date(h.ts);
    item.innerHTML = `${escapeHtml(h.topic)}<br><span class="date">${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}</span>`;
    item.addEventListener("click", () => loadHistory(i));
    el.appendChild(item);
  });
}
function loadHistory(i) {
  const h = state.history[i];
  if (!h) return;
  $("#topic").value = h.topic;
  $("#scripture").value = h.scripture || "";
  finalMarkdown = h.final || "";
  state.results = {};
  for (const [id, r] of Object.entries(h.reports || {})) {
    state.results[id] = { status: "done", text: r.text };
  }
  const synth = state.depts.find((d) => d.type === "synth");
  if (synth && h.final) state.results[synth.id] = { status: "done", text: h.final };
  activeTab = "final";
  syncTabs();
  renderNodes();
  renderPanel();
  $("#runStatus").textContent = "📁 기록을 불러왔습니다.";
}

// ─────────── 부서 편집 모달 ───────────
function openModal(deptId) {
  editingDeptId = deptId;
  const isNew = deptId === null;
  const d = isNew
    ? { icon: "🏬", name: "새 부서", prompt: `당신은 교회 설교 준비팀의 [새 부서] 연구원입니다.\n설교 주제: {topic}\n본문 말씀: {scripture}\n추가 지시: {extra}\n\n(이 부서의 역할을 여기에 정의하세요)` + COMMON_RULES, model: "", enabled: true, type: "research", webSearch: true, searchQuery: "{topic}" }
    : state.depts.find((x) => x.id === deptId);
  $("#modal-title").textContent = isNew ? "새 부서 추가" : "부서 편집 — " + d.name;
  $("#m-icon").value = d.icon;
  $("#m-name").value = d.name;
  $("#m-prompt").value = d.prompt;
  // 전용 모델: 연결된 엔진의 모델 목록으로 드롭다운 구성
  const msel = $("#m-model");
  msel.innerHTML = "";
  msel.add(new Option("(기본 모델 사용)", ""));
  for (const m of availableModels) msel.add(new Option(m, m));
  if (d.model && !availableModels.includes(d.model)) {
    msel.add(new Option(d.model + " (현재 엔진에 없음)", d.model));
  }
  msel.value = d.model || "";
  $("#m-enabled").checked = d.enabled;
  $("#m-search-row").style.display = d.type === "synth" ? "none" : "block";
  $("#m-websearch").checked = d.webSearch !== false;
  $("#m-searchquery").value = d.searchQuery || "{topic}";
  $("#m-delete").style.display = isNew || d.type === "synth" ? "none" : "block";
  $("#modal-backdrop").classList.remove("hidden");
}
function closeModal() { $("#modal-backdrop").classList.add("hidden"); }

// ─────────── 모델 보관함 (HuggingFace → models/ 폴더) ───────────
let pollTimer = null;

async function hubSearch() {
  const q = $("#hubQuery").value.trim();
  const box = $("#hubResults");
  box.innerHTML = `<div class="hub-item">검색 중…</div>`;
  try {
    const res = await fetch("/api/hub/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q }),
    });
    const out = await res.json();
    if (out.error || !out.results.length) {
      box.innerHTML = `<div class="hub-item">${escapeHtml(out.error || "검색 결과 없음")}</div>`;
      return;
    }
    box.innerHTML = "";
    for (const r of out.results) {
      const item = document.createElement("div");
      item.className = "hub-item" + (r.mlx ? " mlx-ok" : "");
      item.innerHTML = `
        <span class="hub-name" title="${escapeHtml(r.id)}">${r.mlx ? "🟢 " : ""}${escapeHtml(r.id)}</span>
        <span class="hub-meta">⬇${(r.downloads / 1000).toFixed(0)}k</span>
        <button data-repo="${escapeHtml(r.id)}">받기</button>`;
      item.querySelector("button").addEventListener("click", (e) => startDownload(e.target.dataset.repo, e.target));
      box.appendChild(item);
    }
  } catch (e) {
    box.innerHTML = `<div class="hub-item">검색 실패: ${escapeHtml(e.message)}</div>`;
  }
}

async function startDownload(repoId, btn) {
  btn.disabled = true;
  const res = await fetch("/api/hub/download", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoId }),
  });
  const out = await res.json();
  if (out.error) { $("#mlxStatus").textContent = "⚠ " + out.error; btn.disabled = false; return; }
  $("#mlxStatus").textContent = "⬇ 다운로드 시작: " + repoId;
  startProgressPolling();
}

function startProgressPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const out = await (await fetch("/api/hub/progress")).json();
      const active = Object.entries(out.downloads || {}).filter(([, d]) => d.status === "downloading");
      if (!active.length) {
        clearInterval(pollTimer); pollTimer = null;
        const all = Object.entries(out.downloads || {});
        if (all.length) {
          const errs = all.filter(([, d]) => d.status === "error");
          $("#mlxStatus").textContent = errs.length
            ? "⚠ 다운로드 실패: " + errs[0][1].error
            : "✓ 다운로드 완료 — 보관함에 추가되었습니다.";
          loadLocalModels();
        }
        return;
      }
      const [id, d] = active[0];
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      const gb = (d.done / 1073741824).toFixed(2);
      $("#mlxStatus").textContent = `⬇ ${id} — ${pct}% (${gb}GB) ${d.file || ""}`;
    } catch (e) { /* 서버 재시작 등은 다음 틱에 재시도 */ }
  }, 1500);
}

async function loadLocalModels() {
  const box = $("#localModels");
  try {
    const out = await (await fetch("/api/local-models")).json();
    if (!out.models.length) {
      box.innerHTML = `<div class="hub-item">아직 보관된 모델이 없습니다. 위에서 검색해 받으세요.</div>`;
      return;
    }
    box.innerHTML = "";
    for (const m of out.models) {
      const item = document.createElement("div");
      item.className = "hub-item" + (m.hasSafetensors ? " mlx-ok" : "");
      item.innerHTML = `
        <span class="hub-name" title="${escapeHtml(m.path)}">${escapeHtml(m.id)}</span>
        <span class="hub-meta">${m.sizeGB}GB</span>
        <button data-path="${escapeHtml(m.path)}" title="이 모델로 MLX 서버 실행">▶ MLX</button>`;
      item.querySelector("button").addEventListener("click", (e) => mlxStart(e.target.dataset.path));
      box.appendChild(item);
    }
  } catch (e) {
    box.innerHTML = `<div class="hub-item">목록 조회 실패</div>`;
  }
}

async function mlxStart(path) {
  $("#mlxStatus").textContent = "MLX 서버 시작 중…";
  const res = await fetch("/api/engine/mlx", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", path }),
  });
  const out = await res.json();
  if (out.error) { $("#mlxStatus").textContent = "⚠ " + out.error; return; }
  $("#mlxStatus").textContent = "✓ MLX 서버 시작됨 (포트 10240) — " + out.note;
  // 엔진을 MLX 프리셋으로 자동 전환
  const p = $("#provider");
  p.value = "mlx";
  p.dispatchEvent(new Event("change"));
}

// ─────────── 엔진 설정 ───────────
let availableModels = []; // 현재 연결된 엔진의 모델 목록 (부서 전용 모델 선택에 사용)
const STATIC_MODELS = {
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5-20251001"],
  demo: ["demo"],
};
function setEngineStatus(msg, cls) {
  $("#engineStatus").textContent = msg;
  $("#engineStatus").className = "engine-status" + (cls ? " " + cls : "");
}
async function refreshModels() {
  const sel = $("#defaultModel");
  const s = state.settings;
  const preset = ENGINE_PRESETS[s.enginePreset] || ENGINE_PRESETS.custom;
  sel.innerHTML = "";

  availableModels = [];
  if (preset.protocol === "demo" || preset.protocol === "anthropic") {
    for (const m of STATIC_MODELS[preset.protocol]) sel.add(new Option(m, m));
    availableModels = STATIC_MODELS[preset.protocol].slice();
    setEngineStatus(preset.hint);
  } else {
    // Ollama·OpenAI 호환 서버에서 실제 모델 목록 조회
    setEngineStatus("모델 목록 조회 중…");
    try {
      const res = await fetch("/api/models", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: preset.protocol, baseUrl: s.baseUrl, apiKey: s.apiKey }),
      });
      const out = await res.json();
      if (out.error || !out.models.length) {
        sel.innerHTML = `<option value="">(모델 없음)</option>`;
        setEngineStatus("⚠ 연결 안 됨 — " + preset.hint, "err");
        return;
      }
      for (const m of out.models) sel.add(new Option(m, m));
      availableModels = out.models.slice();
      setEngineStatus(`✓ 연결됨 · 모델 ${out.models.length}개`, "ok");
    } catch (e) {
      sel.innerHTML = `<option value="">(연결 실패)</option>`;
      setEngineStatus("⚠ 서버 연결 실패: " + e.message, "err");
    }
  }
  if (s.defaultModel && [...sel.options].some((o) => o.value === s.defaultModel)) sel.value = s.defaultModel;
  state.settings.defaultModel = sel.value;
  persist();
}

// ─────────── 이벤트 바인딩 ───────────
function bind() {
  $("#runBtn").addEventListener("click", runPipeline);
  $("#stopBtn").addEventListener("click", () => { abortRequested = true; $("#runStatus").textContent = "중단 요청됨 — 현재 부서 호출이 끝나면 멈춥니다…"; });

  $("#topic").addEventListener("input", () => renderNodes());

  // 엔진 설정
  const s = state.settings;
  $("#provider").value = s.enginePreset;
  $("#baseUrl").value = s.baseUrl;
  $("#apiKey").value = s.apiKey;
  $("#provider").addEventListener("change", (e) => {
    const preset = ENGINE_PRESETS[e.target.value];
    s.enginePreset = e.target.value;
    s.provider = preset.protocol;
    if (preset.baseUrl) { s.baseUrl = preset.baseUrl; $("#baseUrl").value = preset.baseUrl; }
    persist(); refreshModels();
  });
  $("#baseUrl").addEventListener("change", (e) => { s.baseUrl = e.target.value.trim(); persist(); refreshModels(); });
  $("#apiKey").addEventListener("change", (e) => { s.apiKey = e.target.value.trim(); persist(); });
  $("#defaultModel").addEventListener("change", (e) => { s.defaultModel = e.target.value; persist(); });
  $("#refreshModels").addEventListener("click", refreshModels);

  // 테마
  document.body.dataset.theme = s.theme || "dark";
  $("#themeSel").value = s.theme || "dark";
  $("#themeSel").addEventListener("change", (e) => {
    s.theme = e.target.value;
    document.body.dataset.theme = s.theme;
    persist();
  });

  // 실행 옵션
  $("#runMode").value = s.runMode || "seq";
  $("#webSearchOn").checked = s.webSearch !== false;
  $("#deepFetch").checked = s.deepFetch !== false;
  $("#runMode").addEventListener("change", (e) => { s.runMode = e.target.value; persist(); });
  $("#webSearchOn").addEventListener("change", (e) => { s.webSearch = e.target.checked; persist(); renderNodes(); });
  $("#deepFetch").addEventListener("change", (e) => { s.deepFetch = e.target.checked; persist(); });

  // 탭
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => { activeTab = t.dataset.tab; syncTabs(); renderPanel(); })
  );

  // 복사/다운로드/저장
  $("#copyBtn").addEventListener("click", async () => {
    const text = currentPanelText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    $("#copyBtn").textContent = "복사됨 ✓";
    setTimeout(() => ($("#copyBtn").textContent = "복사"), 1500);
  });
  $("#downloadBtn").addEventListener("click", () => {
    const text = currentPanelText();
    if (!text) return;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = ($("#topic").value.trim() || "설교문") + ".md";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#downloadDocxBtn").addEventListener("click", async () => {
    const text = currentPanelText();
    if (!text) return;
    const btn = $("#downloadDocxBtn");
    btn.textContent = "변환 중…";
    try {
      const res = await fetch("/api/docx", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: text }),
      });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ($("#topic").value.trim() || "설교문") + ".docx";
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      btn.textContent = ".docx";
    }
  });
  $("#downloadPptxBtn").addEventListener("click", async () => {
    const text = currentPanelText();
    if (!text) return;
    const btn = $("#downloadPptxBtn");
    btn.textContent = "변환 중…";
    try {
      const res = await fetch("/api/pptx", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: text, title: $("#topic").value.trim() }),
      });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = ($("#topic").value.trim() || "설교문") + ".pptx";
      a.click();
      URL.revokeObjectURL(a.href);
    } finally {
      btn.textContent = ".pptx";
    }
  });
  $("#saveBtn").addEventListener("click", async () => {
    const text = currentPanelText();
    if (!text) return;
    const res = await fetch("/api/save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: $("#topic").value.trim(), content: text }),
    });
    const out = await res.json();
    $("#runStatus").textContent = out.saved ? "💾 저장됨: " + out.saved : "저장 실패: " + out.error;
  });

  // 부서 추가/배치 초기화
  $("#addDept").addEventListener("click", () => openModal(null));
  $("#resetLayout").addEventListener("click", () => { state.positions = {}; persist(); renderNodes(); });

  // 모델 보관함
  $("#hubSearchBtn").addEventListener("click", hubSearch);
  $("#hubQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") hubSearch(); });
  $("#localRefresh").addEventListener("click", loadLocalModels);

  // 기록
  $("#clearHistory").addEventListener("click", () => { state.history = []; persist(); renderHistory(); });

  // 모달
  $("#m-cancel").addEventListener("click", closeModal);
  $("#modal-backdrop").addEventListener("click", (e) => { if (e.target.id === "modal-backdrop") closeModal(); });
  $("#m-save").addEventListener("click", () => {
    const data = {
      icon: $("#m-icon").value || "🏬",
      name: $("#m-name").value.trim() || "이름 없는 부서",
      prompt: $("#m-prompt").value,
      model: $("#m-model").value,
      enabled: $("#m-enabled").checked,
      webSearch: $("#m-websearch").checked,
      searchQuery: $("#m-searchquery").value.trim() || "{topic}",
    };
    if (editingDeptId === null) {
      const id = "dept-" + Date.now();
      // 편집국(synth) 앞에 삽입
      const synthIdx = state.depts.findIndex((d) => d.type === "synth");
      const newDept = { id, type: "research", ...data };
      if (synthIdx >= 0) state.depts.splice(synthIdx, 0, newDept);
      else state.depts.push(newDept);
    } else {
      const d = state.depts.find((x) => x.id === editingDeptId);
      Object.assign(d, data);
    }
    persist(); closeModal(); renderNodes();
  });
  $("#m-delete").addEventListener("click", () => {
    if (editingDeptId === null) return;
    state.depts = state.depts.filter((d) => d.id !== editingDeptId);
    delete state.positions[editingDeptId];
    persist(); closeModal(); renderNodes();
  });
}

// ─────────── 시작 ───────────
restore();
bind();
renderNodes();
renderHistory();
renderPanel();
refreshModels();
loadLocalModels();
startProgressPolling(); // 서버 재시작 전에 진행 중이던 다운로드가 있으면 이어서 표시
