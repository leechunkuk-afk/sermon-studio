#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
설교 스튜디오 로컬 서버
- 정적 파일 서빙 (index.html, app.js, style.css)
- /api/llm      : LLM 백엔드 프록시 (Ollama / OpenAI 호환 / Anthropic) — 브라우저 CORS 문제 회피
- /api/models   : Ollama 설치 모델 목록 조회
- /api/save     : 완성된 설교문을 output/ 폴더에 저장

의존성 없음 — Python 3 표준 라이브러리만 사용.
실행:  python3 server.py  (기본 포트 8787)
- /api/search    : DuckDuckGo 웹 검색 (API 키 불필요) + 상위 결과 본문 수집
- /api/docx      : 마크다운 → Word(.docx) 변환
- /api/pptx      : 마크다운 → PowerPoint(.pptx) 변환 (예배 프로젝션용 슬라이드)
- /api/hub/*     : HuggingFace 모델 검색·다운로드 (models/ 폴더에 보관)
- /api/local-models : models/ 폴더의 보관 모델 목록
- /api/engine/mlx   : 보관된 모델로 MLX 서버 시작/정지
"""
import html as html_mod
import io
import json
import os
import re
import sys
import urllib.request
import urllib.error
import urllib.parse
import zipfile
import threading
import subprocess
import importlib.util
import webbrowser
from datetime import datetime
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

ARGS = sys.argv[1:]
PORT = next((int(a) for a in ARGS if a.isdigit()), 8787)
ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUT_DIR = os.path.join(ROOT, "output")
MODELS_DIR = os.path.join(ROOT, "models")
LLM_TIMEOUT = 600  # 로컬 모델은 생성이 오래 걸릴 수 있음

# 진행 중인 HuggingFace 다운로드 상태: repoId -> {status, total, done, file, error}
DOWNLOADS = {}
DOWNLOADS_LOCK = threading.Lock()
MLX_PROC = None  # 실행 중인 MLX 서버 프로세스


def http_json(url, payload=None, headers=None, timeout=LLM_TIMEOUT, method=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def call_llm(cfg):
    """cfg: {provider, baseUrl, apiKey, model, system, prompt, temperature}"""
    provider = cfg.get("provider", "ollama")
    model = cfg.get("model") or ""
    system = cfg.get("system") or ""
    prompt = cfg.get("prompt") or ""
    temperature = float(cfg.get("temperature", 0.7))

    if provider == "ollama":
        base = (cfg.get("baseUrl") or "http://localhost:11434").rstrip("/")
        body = {
            "model": model,
            "stream": False,
            "options": {"temperature": temperature},
            "messages": ([{"role": "system", "content": system}] if system else [])
            + [{"role": "user", "content": prompt}],
        }
        out = http_json(base + "/api/chat", body)
        return out.get("message", {}).get("content", "")

    if provider == "openai":
        base = (cfg.get("baseUrl") or "https://api.openai.com").rstrip("/")
        # /v1 등 API 경로가 이미 포함돼 있으면 그대로, 도메인만 있으면 /v1 보정
        # (Gemini의 OpenAI 호환 주소는 .../v1beta/openai 로 끝남)
        if not (base.endswith("/v1") or base.endswith("/openai")):
            base += "/v1"
        headers = {}
        if cfg.get("apiKey"):
            headers["Authorization"] = "Bearer " + cfg["apiKey"]
        body = {
            "model": model,
            "temperature": temperature,
            "messages": ([{"role": "system", "content": system}] if system else [])
            + [{"role": "user", "content": prompt}],
        }
        out = http_json(base + "/chat/completions", body, headers)
        return out["choices"][0]["message"]["content"]

    if provider == "anthropic":
        headers = {
            "x-api-key": cfg.get("apiKey") or "",
            "anthropic-version": "2023-06-01",
        }
        body = {
            "model": model or "claude-sonnet-5",
            "max_tokens": 4096,
            "temperature": temperature,
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            body["system"] = system
        out = http_json("https://api.anthropic.com/v1/messages", body, headers)
        return "".join(b.get("text", "") for b in out.get("content", []))

    raise ValueError("알 수 없는 provider: " + provider)


# ─────────────── 웹 검색 (DuckDuckGo — API 키 불필요) ───────────────
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch_url(url, timeout=12, max_bytes=400_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Language": "ko,en;q=0.8"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read(max_bytes)
        ctype = resp.headers.get("Content-Type", "")
    m = re.search(r"charset=([\w-]+)", ctype)
    enc = m.group(1) if m else None
    if not enc:
        mm = re.search(rb"charset=[\"']?([\w-]+)", raw[:4000])
        enc = mm.group(1).decode("ascii", "ignore") if mm else "utf-8"
    try:
        return raw.decode(enc, "replace")
    except LookupError:
        return raw.decode("utf-8", "replace")


def strip_html(page):
    page = re.sub(r"(?is)<(script|style|noscript|svg|header|footer|nav)[^>]*>.*?</\1>", " ", page)
    page = re.sub(r"(?s)<[^>]+>", " ", page)
    page = html_mod.unescape(page)
    return re.sub(r"\s+", " ", page).strip()


def _clean_tag_text(s):
    return html_mod.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def ddg_search(query, max_results=6):
    """DuckDuckGo Lite HTML을 파싱해 [{title, url, snippet}] 반환."""
    url = "https://lite.duckduckgo.com/lite/?q=" + urllib.parse.quote(query)
    page = fetch_url(url, timeout=12)
    links = re.findall(r'(?s)<a[^>]+href="([^"]+)"[^>]*class=["\']result-link["\'][^>]*>(.*?)</a>', page)
    if not links:
        links = re.findall(r'(?s)<a rel="nofollow" href="([^"]+)"[^>]*>(.*?)</a>', page)
    snippets = re.findall(r"(?s)<td class=['\"]result-snippet['\"]>(.*?)</td>", page)
    results = []
    for i, (href, title) in enumerate(links):
        if len(results) >= max_results:
            break
        if "duckduckgo.com/y.js" in href:  # 광고 링크 제외
            continue
        if "uddg=" in href:  # DDG 리다이렉트 링크 → 실제 URL 복원
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
            href = qs.get("uddg", [href])[0]
        if not href.startswith("http"):
            continue
        results.append({
            "title": _clean_tag_text(title),
            "url": href,
            "snippet": _clean_tag_text(snippets[i]) if i < len(snippets) else "",
        })
    return results


# ─────────────── HuggingFace 모델 보관함 (models/ 폴더) ───────────────
_REPO_RE = re.compile(r"^[\w.-]+/[\w.-]+$")


def hub_search(query, limit=12):
    url = ("https://huggingface.co/api/models?search=%s&limit=%d&sort=downloads&direction=-1"
           % (urllib.parse.quote(query), limit))
    out = json.loads(fetch_url(url, timeout=15, max_bytes=2_000_000))
    return [{"id": m.get("id"), "downloads": m.get("downloads", 0),
             "likes": m.get("likes", 0),
             "mlx": "mlx" in (m.get("tags") or []) or (m.get("id") or "").startswith("mlx-community/")}
            for m in out if m.get("id")]


def _dir_size(path):
    total = 0
    for dp, _, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dp, f))
            except OSError:
                pass
    return total


def list_local_models():
    """models/ 폴더의 보관 모델 목록: models/<org>/<repo>/ 구조."""
    result = []
    if not os.path.isdir(MODELS_DIR):
        return result
    for org in sorted(os.listdir(MODELS_DIR)):
        org_dir = os.path.join(MODELS_DIR, org)
        if not os.path.isdir(org_dir):
            continue
        for repo in sorted(os.listdir(org_dir)):
            repo_dir = os.path.join(org_dir, repo)
            if not os.path.isdir(repo_dir):
                continue
            rid = org + "/" + repo
            with DOWNLOADS_LOCK:
                dl = DOWNLOADS.get(rid)
            if dl and dl.get("status") == "downloading":
                continue  # 다운로드 중인 것은 진행 목록에서 표시
            result.append({
                "id": rid,
                "path": repo_dir,
                "sizeGB": round(_dir_size(repo_dir) / 1073741824, 2),
                "hasSafetensors": any(f.endswith(".safetensors") for f in os.listdir(repo_dir)),
            })
    return result


def _hub_download_worker(repo):
    try:
        tree = json.loads(fetch_url(
            "https://huggingface.co/api/models/%s/tree/main?recursive=true" % repo,
            timeout=30, max_bytes=5_000_000))
        files = [f for f in tree if f.get("type") == "file"]
        total = sum(f.get("size", 0) for f in files)
        with DOWNLOADS_LOCK:
            DOWNLOADS[repo] = {"status": "downloading", "total": total, "done": 0, "file": ""}
        dest_root = os.path.join(MODELS_DIR, repo)
        for f in files:
            rel = f["path"]
            if ".." in rel or rel.startswith("/"):
                continue  # 경로 탈출 방지
            dest = os.path.join(dest_root, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            with DOWNLOADS_LOCK:
                DOWNLOADS[repo]["file"] = rel
            url = "https://huggingface.co/%s/resolve/main/%s" % (repo, urllib.parse.quote(rel))
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
                    with DOWNLOADS_LOCK:
                        DOWNLOADS[repo]["done"] += len(chunk)
        with DOWNLOADS_LOCK:
            DOWNLOADS[repo]["status"] = "done"
            DOWNLOADS[repo]["file"] = ""
    except Exception as e:
        with DOWNLOADS_LOCK:
            DOWNLOADS[repo] = {"status": "error", "error": str(e), "total": 0, "done": 0, "file": ""}


def start_hub_download(repo):
    if not _REPO_RE.match(repo):
        return {"error": "잘못된 모델 ID 형식입니다 (예: mlx-community/Qwen3-4B-4bit)"}
    with DOWNLOADS_LOCK:
        cur = DOWNLOADS.get(repo)
        if cur and cur.get("status") == "downloading":
            return {"error": "이미 다운로드 중입니다"}
        DOWNLOADS[repo] = {"status": "downloading", "total": 0, "done": 0, "file": "(파일 목록 조회 중)"}
    threading.Thread(target=_hub_download_worker, args=(repo,), daemon=True).start()
    return {"started": repo}


# ─────────────── MLX 서버 시작/정지 (보관된 safetensors 모델 실행) ───────────────
def mlx_control(action, model_path=None):
    global MLX_PROC
    if action == "stop":
        if MLX_PROC and MLX_PROC.poll() is None:
            MLX_PROC.terminate()
            MLX_PROC = None
            return {"stopped": True}
        MLX_PROC = None
        return {"stopped": False, "error": "실행 중인 MLX 서버가 없습니다"}

    if action == "status":
        running = MLX_PROC is not None and MLX_PROC.poll() is None
        return {"running": running}

    if action == "start":
        if importlib.util.find_spec("mlx_lm") is None:
            return {"error": "mlx-lm이 설치되어 있지 않습니다. 폴더의 `MLX 모델서버 시작.command`를 "
                             "실행하면 설치를 안내합니다."}
        real = os.path.realpath(model_path or "")
        if not real.startswith(os.path.realpath(MODELS_DIR)) or not os.path.isdir(real):
            return {"error": "models/ 폴더 안의 모델만 실행할 수 있습니다"}
        if MLX_PROC and MLX_PROC.poll() is None:
            MLX_PROC.terminate()
        log = open(os.path.join(MODELS_DIR, "mlx-server.log"), "w")
        MLX_PROC = subprocess.Popen(
            [sys.executable, "-m", "mlx_lm.server", "--model", real, "--port", "10240"],
            stdout=log, stderr=log)
        return {"started": True, "port": 10240,
                "note": "모델 로딩에 수십 초 걸릴 수 있습니다. 엔진을 'MLX'로 바꾸고 ⟳를 누르세요."}

    return {"error": "알 수 없는 action"}


# ─────────────── 마크다운 → .docx 변환 (표준 라이브러리만 사용) ───────────────
def _xml_escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _runs(text, extra_rpr=""):
    """**굵게** 를 파싱해 <w:r> 런 목록 생성."""
    parts = re.split(r"\*\*(.+?)\*\*", text)
    out = []
    for i, part in enumerate(parts):
        if not part:
            continue
        part = re.sub(r"\*(.+?)\*", r"\1", part)  # 이탤릭 마커는 텍스트만 유지
        bold = "<w:b/>" if i % 2 == 1 else ""
        rpr = "<w:rPr>%s%s</w:rPr>" % (extra_rpr, bold) if (extra_rpr or bold) else ""
        out.append('<w:r>%s<w:t xml:space="preserve">%s</w:t></w:r>' % (rpr, _xml_escape(part)))
    return "".join(out) or "<w:r><w:t/></w:r>"


def md_to_docx_bytes(md):
    HEAD_SZ = {1: "44", 2: "36", 3: "30"}  # half-points: 22/18/15pt
    paras = []

    def p(runs, ppr=""):
        paras.append("<w:p>%s%s</w:p>" % ("<w:pPr>%s</w:pPr>" % ppr if ppr else "", runs))

    for line in md.split("\n"):
        t = line.strip()
        m = re.match(r"^(#{1,3})\s+(.*)", t)
        if m:
            lvl = len(m.group(1))
            sz = HEAD_SZ[lvl]
            p(_runs(m.group(2), '<w:b/><w:sz w:val="%s"/><w:szCs w:val="%s"/>' % (sz, sz)),
              '<w:spacing w:before="240" w:after="120"/>')
            continue
        if re.match(r"^(-{3,}|━+)$", t):
            p(_runs("─" * 30))
            continue
        m = re.match(r"^>\s?(.*)", t)
        if m:
            p(_runs(m.group(1), "<w:i/>"), '<w:ind w:left="420"/>')
            continue
        m = re.match(r"^[-*]\s+(.*)", t)
        if m:
            p(_runs("• " + m.group(1)), '<w:ind w:left="420"/>')
            continue
        m = re.match(r"^(\d+[.)]\s+.*)", t)
        if m:
            p(_runs(m.group(1)), '<w:ind w:left="420"/>')
            continue
        p(_runs(t))

    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>%s<w:sectPr/></w:body></w:document>" % "".join(paras)
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/></Relationships>'
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document)
    return buf.getvalue()


# ─────────────── 마크다운 → .pptx 변환 (예배 프로젝션용 슬라이드) ───────────────
PPT_BG = "0F1117"        # 슬라이드 배경 (다크)
PPT_TITLE_CLR = "F0C75E" # 제목 (골드)
PPT_BODY_CLR = "F2F4FA"  # 본문 (화이트)
PPT_SUB_CLR = "9BA3BC"   # 부제 (그레이)
MAX_LINES_PER_SLIDE = 7


def _strip_md_inline(s):
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"\*(.+?)\*", r"\1", s)
    s = re.sub(r"`(.+?)`", r"\1", s)
    return s.strip()


def md_to_slide_data(md, fallback_title):
    """마크다운 → (제목, 부제 목록, [{title, lines}]) 슬라이드 데이터.
    H1은 표지 제목, H2/H3마다 새 슬라이드, 긴 문단은 문장 단위로 분할."""
    title, seen_h1 = (fallback_title or "설교"), False
    subtitle, slides, cur = [], [], None
    for line in md.split("\n"):
        t = line.strip()
        if not t or re.match(r"^(-{3,}|━+)$", t):
            continue
        m = re.match(r"^(#{1,3})\s+(.*)", t)
        if m:
            text = _strip_md_inline(m.group(2))
            if len(m.group(1)) == 1 and not seen_h1:
                title, seen_h1 = text, True
                continue
            cur = {"title": text, "lines": []}
            slides.append(cur)
            continue
        is_bullet = bool(re.match(r"^([-*]|\d+[.)])\s+", t))
        # 불릿 마커는 반드시 뒤에 공백이 있어야 제거 (** 볼드 마커 오인 방지)
        body = _strip_md_inline(re.sub(r"^([-*]|\d+[.)])\s+|^>\s*", "", t))
        if not body:
            continue
        if cur is None:  # 표지의 부제 (본문 구절 등)
            if len(subtitle) < 3:
                subtitle.append(body)
            continue
        if not is_bullet and len(body) > 90:  # 긴 문단은 문장 단위로
            cur["lines"].extend(s.strip() for s in re.split(r"(?<=[.!?])\s+", body) if s.strip())
        else:
            cur["lines"].append(body)
    # 슬라이드당 줄 수 제한 → 넘치면 (계속) 슬라이드로 분할
    paged = []
    for s in slides:
        chunks = [s["lines"][i:i + MAX_LINES_PER_SLIDE] for i in range(0, len(s["lines"]), MAX_LINES_PER_SLIDE)] or [[]]
        for ci, chunk in enumerate(chunks):
            paged.append({"title": s["title"] + (" (계속)" if ci else ""), "lines": chunk})
    return title, subtitle, paged


def _ppt_para(text, sz, color, bold=False, align=None, bullet=False):
    algn = ' algn="%s"' % align if align else ""
    if bullet:
        ppr = ('<a:pPr%s marL="285750" indent="-285750"><a:buClr><a:srgbClr val="%s"/></a:buClr>'
               '<a:buChar char="•"/></a:pPr>' % (algn, PPT_TITLE_CLR))
    else:
        ppr = "<a:pPr%s><a:buNone/></a:pPr>" % algn
    return ('<a:p>%s<a:r><a:rPr lang="ko-KR" sz="%d"%s dirty="0">'
            '<a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:rPr>'
            '<a:t>%s</a:t></a:r></a:p>' % (ppr, sz, ' b="1"' if bold else "", color, _xml_escape(text)))


def _ppt_textbox(shape_id, name, x, y, cx, cy, paras, anchor="t"):
    return ('<p:sp><p:nvSpPr><p:cNvPr id="%d" name="%s"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
            '<p:spPr><a:xfrm><a:off x="%d" y="%d"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
            '<p:txBody><a:bodyPr wrap="square" anchor="%s"><a:normAutofit/></a:bodyPr><a:lstStyle/>%s</p:txBody>'
            "</p:sp>" % (shape_id, name, x, y, cx, cy, anchor, paras or _ppt_para("", 1800, PPT_BODY_CLR)))


_PPT_EMPTY_TREE = ('<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
                   '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
                   '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>')
_PPT_NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
           'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
           'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"')
_PPT_BG_XML = ('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="%s"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>'
               % PPT_BG)
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_ODOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _slide_xml(shapes):
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            "<p:sld %s><p:cSld>%s<p:spTree>%s%s</p:spTree></p:cSld>"
            "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
            % (_PPT_NS, _PPT_BG_XML, _PPT_EMPTY_TREE, shapes))


def md_to_pptx_bytes(md, fallback_title=""):
    title, subtitle, content = md_to_slide_data(md, fallback_title)

    slide_xmls = []
    # 표지 슬라이드
    cover = _ppt_textbox(2, "Title", 914400, 2100000, 10363200, 1600000,
                         _ppt_para(title, 4400, PPT_TITLE_CLR, bold=True, align="ctr"), anchor="b")
    cover += _ppt_textbox(3, "Subtitle", 914400, 3900000, 10363200, 1200000,
                          "".join(_ppt_para(s, 2400, PPT_SUB_CLR, align="ctr") for s in subtitle))
    slide_xmls.append(_slide_xml(cover))
    # 내용 슬라이드
    for s in content:
        shapes = _ppt_textbox(2, "Title", 685800, 365760, 10820400, 950000,
                              _ppt_para(s["title"], 3200, PPT_TITLE_CLR, bold=True))
        shapes += _ppt_textbox(3, "Body", 685800, 1500000, 10820400, 4900000,
                               "".join(_ppt_para(l, 2200, PPT_BODY_CLR, bullet=True) for l in s["lines"]))
        slide_xmls.append(_slide_xml(shapes))

    n = len(slide_xmls)
    overrides = "".join(
        '<Override PartName="/ppt/slides/slide%d.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' % (i + 1)
        for i in range(n))
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/ppt/presentation.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
        '<Override PartName="/ppt/theme/theme1.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
        "%s</Types>" % overrides)
    root_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Relationships xmlns="%s"><Relationship Id="rId1" Type="%s/officeDocument" '
                 'Target="ppt/presentation.xml"/></Relationships>' % (_REL_NS, _ODOC_REL))
    sld_ids = "".join('<p:sldId id="%d" r:id="rId%d"/>' % (256 + i, 2 + i) for i in range(n))
    presentation = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        "<p:presentation %s>"
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        "<p:sldIdLst>%s</p:sldIdLst>"
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
        "</p:presentation>" % (_PPT_NS, sld_ids))
    pres_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
                 '<Relationship Id="rId1" Type="%s/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
                 % (_REL_NS, _ODOC_REL))
    pres_rels += "".join('<Relationship Id="rId%d" Type="%s/slide" Target="slides/slide%d.xml"/>'
                         % (2 + i, _ODOC_REL, i + 1) for i in range(n)) + "</Relationships>"
    master = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              "<p:sldMaster %s><p:cSld>%s<p:spTree>%s</p:spTree></p:cSld>"
              '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" '
              'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" '
              'hlink="hlink" folHlink="folHlink"/>'
              '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
              "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"
              % (_PPT_NS, _PPT_BG_XML, _PPT_EMPTY_TREE))
    master_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
                   '<Relationship Id="rId1" Type="%s/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                   '<Relationship Id="rId2" Type="%s/theme" Target="../theme/theme1.xml"/>'
                   "</Relationships>" % (_REL_NS, _ODOC_REL, _ODOC_REL))
    layout = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
              '<p:sldLayout %s type="blank"><p:cSld><p:spTree>%s</p:spTree></p:cSld>'
              "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>" % (_PPT_NS, _PPT_EMPTY_TREE))
    layout_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
                   '<Relationship Id="rId1" Type="%s/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
                   "</Relationships>" % (_REL_NS, _ODOC_REL))
    theme = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="SermonStudio">'
        "<a:themeElements>"
        '<a:clrScheme name="SermonStudio"><a:dk1><a:srgbClr val="000000"/></a:dk1>'
        '<a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2>'
        '<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="7C6FF0"/></a:accent1>'
        '<a:accent2><a:srgbClr val="F0C75E"/></a:accent2><a:accent3><a:srgbClr val="4FC3F7"/></a:accent3>'
        '<a:accent4><a:srgbClr val="4CAF7D"/></a:accent4><a:accent5><a:srgbClr val="E25C5C"/></a:accent5>'
        '<a:accent6><a:srgbClr val="8B91A7"/></a:accent6><a:hlink><a:srgbClr val="4FC3F7"/></a:hlink>'
        '<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>'
        '<a:fontScheme name="SermonStudio"><a:majorFont><a:latin typeface="Calibri"/>'
        '<a:ea typeface="맑은 고딕"/><a:cs typeface=""/></a:majorFont>'
        '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface="맑은 고딕"/><a:cs typeface=""/>'
        "</a:minorFont></a:fontScheme>"
        '<a:fmtScheme name="SermonStudio">'
        '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
        '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
        '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
        "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>"
        "<a:effectStyle><a:effectLst/></a:effectStyle>"
        "<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>"
        '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
        '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
        "</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", root_rels)
        z.writestr("ppt/presentation.xml", presentation)
        z.writestr("ppt/_rels/presentation.xml.rels", pres_rels)
        z.writestr("ppt/slideMasters/slideMaster1.xml", master)
        z.writestr("ppt/slideMasters/_rels/slideMaster1.xml.rels", master_rels)
        z.writestr("ppt/slideLayouts/slideLayout1.xml", layout)
        z.writestr("ppt/slideLayouts/_rels/slideLayout1.xml.rels", layout_rels)
        z.writestr("ppt/theme/theme1.xml", theme)
        slide_rels = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="%s">'
                      '<Relationship Id="rId1" Type="%s/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
                      "</Relationships>" % (_REL_NS, _ODOC_REL))
        for i, sx in enumerate(slide_xmls):
            z.writestr("ppt/slides/slide%d.xml" % (i + 1), sx)
            z.writestr("ppt/slides/_rels/slide%d.xml.rels" % (i + 1), slide_rels)
    return buf.getvalue()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (datetime.now().strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        # 브라우저가 옛 버전 UI(app.js 등)를 캐시해 새 기능이 안 보이는 문제 방지
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length).decode("utf-8")) if length else {}

    def do_GET(self):
        if self.path.startswith("/api/local-models"):
            try:
                self._send(200, {"models": list_local_models()})
            except Exception as e:
                self._send(200, {"models": [], "error": str(e)})
            return
        if self.path.startswith("/api/hub/progress"):
            with DOWNLOADS_LOCK:
                self._send(200, {"downloads": dict(DOWNLOADS)})
            return
        if self.path.startswith("/api/models"):
            base = "http://localhost:11434"
            m = re.search(r"baseUrl=([^&]+)", self.path)
            if m:
                base = urllib.parse.unquote(m.group(1)).rstrip("/")
            try:
                out = http_json(base + "/api/tags", timeout=5)
                names = [t.get("name") for t in out.get("models", [])]
                self._send(200, {"models": names})
            except Exception as e:
                self._send(200, {"models": [], "error": str(e)})
            return
        super().do_GET()

    def do_POST(self):
        try:
            if self.path == "/api/llm":
                cfg = self._read_body()
                try:
                    text = call_llm(cfg)
                    self._send(200, {"text": text})
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", "replace")[:1000]
                    self._send(200, {"error": "백엔드 오류 HTTP %d: %s" % (e.code, detail)})
                except urllib.error.URLError as e:
                    self._send(200, {"error": "백엔드에 연결할 수 없습니다: %s" % e.reason})
                return

            if self.path == "/api/models":
                # 모델 목록 조회: Ollama(/api/tags) 또는 OpenAI 호환(/v1/models)
                data = self._read_body()
                kind = data.get("kind", "ollama")
                base = (data.get("baseUrl") or "").rstrip("/")
                try:
                    if kind == "ollama":
                        out = http_json((base or "http://localhost:11434") + "/api/tags", timeout=5)
                        names = [t.get("name") for t in out.get("models", [])]
                    else:
                        if not (base.endswith("/v1") or base.endswith("/openai")):
                            base += "/v1"
                        headers = {}
                        if data.get("apiKey"):
                            headers["Authorization"] = "Bearer " + data["apiKey"]
                        out = http_json(base + "/models", headers=headers, timeout=8)
                        names = [m.get("id") for m in out.get("data", [])]
                    self._send(200, {"models": [n for n in names if n]})
                except Exception as e:
                    self._send(200, {"models": [], "error": str(e)})
                return

            if self.path == "/api/hub/search":
                data = self._read_body()
                try:
                    self._send(200, {"results": hub_search((data.get("query") or "").strip() or "mlx-community")})
                except Exception as e:
                    self._send(200, {"results": [], "error": str(e)})
                return

            if self.path == "/api/hub/download":
                data = self._read_body()
                self._send(200, start_hub_download((data.get("repoId") or "").strip()))
                return

            if self.path == "/api/engine/mlx":
                data = self._read_body()
                self._send(200, mlx_control(data.get("action"), data.get("path")))
                return

            if self.path == "/api/search":
                data = self._read_body()
                query = (data.get("query") or "").strip()
                if not query:
                    self._send(200, {"results": [], "error": "빈 검색어"})
                    return
                try:
                    results = ddg_search(query, int(data.get("max", 6)))
                except Exception as e:
                    self._send(200, {"results": [], "error": "검색 실패: %s" % e})
                    return
                fetch_n = min(int(data.get("fetchPages", 0)), 3)
                for r in results[:fetch_n]:
                    try:
                        r["content"] = strip_html(fetch_url(r["url"], timeout=10))[:2500]
                    except Exception:
                        pass  # 본문 수집 실패는 무시하고 스니펫만 사용
                self._send(200, {"results": results})
                return

            if self.path == "/api/docx":
                data = self._read_body()
                body = md_to_docx_bytes(data.get("markdown", ""))
                self.send_response(200)
                self.send_header("Content-Type",
                                 "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if self.path == "/api/pptx":
                data = self._read_body()
                body = md_to_pptx_bytes(data.get("markdown", ""), data.get("title", ""))
                self.send_response(200)
                self.send_header("Content-Type",
                                 "application/vnd.openxmlformats-officedocument.presentationml.presentation")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return

            if self.path == "/api/save":
                data = self._read_body()
                os.makedirs(OUTPUT_DIR, exist_ok=True)
                title = re.sub(r"[^\w가-힣 -]", "", data.get("title", "설교문"))[:50].strip() or "설교문"
                fname = "%s_%s.md" % (datetime.now().strftime("%Y%m%d_%H%M%S"), title)
                path = os.path.join(OUTPUT_DIR, fname)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(data.get("content", ""))
                self._send(200, {"saved": path})
                return

            self._send(404, {"error": "not found"})
        except Exception as e:
            self._send(500, {"error": str(e)})


if __name__ == "__main__":
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    os.makedirs(MODELS_DIR, exist_ok=True)
    print("설교 스튜디오 서버 시작: http://localhost:%d" % PORT)
    if "--open" in ARGS:  # 런처(.command/.bat)에서 브라우저 자동 열기
        threading.Timer(1.0, lambda: webbrowser.open("http://localhost:%d" % PORT)).start()
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
