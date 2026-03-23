# ChatFluence

Confluence 문서를 자연어로 검색·조회하고, 페이지 생성·수정·삭제·댓글까지 이어갈 수 있는 AI 챗 애플리케이션입니다.
파일(PDF, Word, PPT, CSV, 이미지 등)을 첨부해 함께 분석할 수도 있습니다.

## 주요 기능

- **자연어 Confluence 검색** — 제목·내용 키워드 또는 CQL 쿼리로 문서 검색
- **페이지 조회** — 특정 페이지의 본문·메타데이터를 마크다운으로 변환해 표시
- **페이지 생성 / 수정 / 삭제** — AI가 작성한 내용을 미리보기 후 확인(실행/취소) 단계를 거쳐 Confluence에 반영
- **댓글 작성** — 특정 페이지에 AI가 작성한 댓글 추가
- **파일 첨부 분석** — PDF, Word(.docx), PowerPoint(.pptx), Excel(.xlsx), CSV, 이미지 등을 첨부하면 텍스트를 추출해 질문·요약에 활용
- **멀티 스페이스** — 드롭다운에서 대상 스페이스를 선택하거나 전체 검색
- **모델 선택** — gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano 중 선택 가능
- **대화 히스토리** — 브라우저 localStorage에 대화 기록 보관

## 사전 준비

| 항목 | 설명 |
|------|------|
| **Python** | 3.11 (셋업 스크립트 기준) |
| **Confluence 토큰** | Confluence 개인 API 토큰 |
| **OpenAI API 키** | 사내 제공 OpenAI API 활용 |

## 설치 및 실행

### 1. 저장소 클론

```bash
git clone https://github.com/vuno/confluence-chat.git
cd confluence-chat
```

### 2. 셋업 스크립트 실행

conda 환경 생성과 `pip install -r requirements.txt`를 한 번에 처리합니다.

**Mac / Linux:**

```bash
./setup.sh
```

**Windows (Anaconda Prompt):**

```bat
setup.bat
```

> 스크립트 없이 수동으로 하려면: `conda create -n chatfluence python=3.11 -y && conda activate chatfluence && pip install -r requirements.txt`

`.env`는 저장소에 포함되어 있습니다. `CONFLUENCE_URL`, `PORT`, `FLASK_SECRET_KEY` 등을 필요에 맞게 수정하세요.  
(코드 기본값: `DEFAULT_EMAIL_DOMAIN=vuno.co`, `AI_MODEL=gpt-5.4-mini` — `.env`에 없어도 동작합니다.)

### 3. 서버 실행

```bash
python server.py
```

정상 시작되면 아래와 같이 출력됩니다.

```
Starting Confluence Chat...
OpenAI model (default): gpt-5.4-mini
Server: Waitress threads=8, http://127.0.0.1:3000
```

> **참고**: 회사 보안 정책에 따라 서버는 `127.0.0.1`(본인 PC)에서만 접속할 수 있도록 바인딩됩니다. 각자 본인 PC에서 서버를 실행해 사용하세요.

### 4. 로그인

브라우저에서 `http://127.0.0.1:3000`에 접속하면 로그인 화면이 나타납니다.

| 입력 항목 | 설명 |
|-----------|------|
| **사용자 ID** | Confluence 계정 ID (예: `gildong.hong`). `@vuno.co`는 자동으로 붙습니다. |
| **Confluence 토큰** | Atlassian에서 발급받은 API 토큰 |
| **OpenAI API 키** | OpenAI에서 발급받은 API 키 (`sk-...`) |

로그인 시 서버가 Confluence와 OpenAI 양쪽 인증을 검증합니다.

## 사용법

### 읽기 (기본)

작업 유형을 **읽기만**으로 두고 질문을 입력하면 AI가 Confluence를 검색·조회해 답변합니다.

**예시 질문:**
- `ARIA-H 프로젝트 관련 문서 찾아줘`
- `DEV 스페이스에서 최근 수정된 페이지 목록 보여줘`
- `페이지 ID 12345의 내용을 요약해줘`

### 쓰기 (페이지 생성·수정·삭제·댓글)

1. 작업 유형에서 원하는 쓰기 작업을 선택합니다 (예: **페이지 생성**).
2. 필요하면 대상 페이지를 검색/URL로 지정합니다.
3. 채팅으로 요청하면 AI가 내용을 생성하고 **미리보기**를 보여줍니다.
4. **실행** 버튼을 누르면 Confluence에 반영되고, **취소**를 누르면 중단됩니다.

### 파일 첨부

입력창 왼쪽 📎 버튼으로 파일을 첨부할 수 있습니다.

| 지원 형식 | 확장자 |
|-----------|--------|
| 문서 | `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.csv`, `.tsv`, `.txt`, `.md`, `.json`, `.xml`, `.html` |
| 이미지 | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` |
| 코드 | `.py`, `.js`, `.ts`, `.yml`, `.yaml`, `.log` |

- 최대 **8개**, 파일당 **20MB** 제한
- 첨부 내용을 바탕으로 Confluence에 요약 페이지를 만들거나 댓글을 달 수도 있습니다

## 프로젝트 구조

```
confluence-chat/
├── server.py              # Flask 백엔드 (API, Confluence 연동, OpenAI 호출)
├── requirements.txt       # Python 의존성
├── .env                   # 환경 변수 (서버 URL, 포트 등)
├── .gitignore
├── setup.sh               # Mac/Linux 셋업 스크립트
├── setup.bat              # Windows 셋업 스크립트
└── public/                # 프론트엔드 (정적 파일)
    ├── index.html
    ├── app.js
    ├── styles.css
    └── asset/             # 로고 등 (vuno_inc_logo.jpeg)
```

## 유의사항

- AI 답변·요약·추출 텍스트는 **참고용**입니다. 임상·법무·보안 등 중요한 판단은 원문과 정책을 기준으로 하세요.
- 불필요한 **개인정보·기밀**은 채팅·첨부에 넣지 마세요. 사내 정보보안 규정을 따라 이용하세요.
- 스캔 PDF·복잡한 서식은 텍스트가 일부만 추출되거나 빠질 수 있습니다.

## 문의

이나혁 (연구개발본부 Fundus팀)
