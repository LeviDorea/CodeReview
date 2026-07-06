# PRzator

Bot de **revisão automática de Pull Requests** no GitHub. Quando um PR é aberto ou atualizado, o sistema analisa o código alterado usando IA (LLM), atribui uma nota e publica um comentário no próprio PR com os problemas encontrados, organizados por criticidade.

## Stack

- **NestJS + TypeScript** — backend modular, organizado por domínio.
- **Prisma + PostgreSQL** — persistência (repositórios, regras, análises, configuração de pontuação).
- **GitHub App + Octokit** — integração com o GitHub via webhooks e API.
- **LangChain + OpenAI (`gpt-4o`)** — motor de análise do código (saída estruturada validada com **Zod**).
- **Arquitetura orientada a eventos** (`@nestjs/event-emitter`) — desacopla as etapas do pipeline.
- **Next.js 16 + React 19** em `webapp/` — dashboard web para análises, regras, repositórios e login via Basic Auth da API.

## Estrutura

- **raiz do repo** — backend NestJS, Prisma, GitHub App, pipeline de análise e scripts operacionais.
- **`webapp/`** — frontend Next.js do PRzator.

## Como funciona (visão geral)

```
Dev abre/atualiza PR no GitHub
        │  (webhook pull_request)
        ▼
WebhookService ── valida assinatura HMAC SHA-256 ── identifica o repo
        │  (emite evento "analysis.requested")
        ▼
AnalysisService (pipeline)
   1. Busca contexto do PR + arquivos alterados (diff) + linguagens via GitHub API
   2. Carrega regras ativas do repositório (banco)
   3. Coleta contexto de arquivos relacionados/importados (SharedFilesService)
   4. Envia tudo para o LLM analisar (LlmService)
   5. Calcula a nota (ScoringService)
   6. Salva a análise e emite "analysis.completed"
        │
        ▼
CommentService formata Markdown ── GithubService publica o comentário no PR
```

Diagrama visual: [PRzator — Fluxo de Análise de PR (FigJam)](https://www.figma.com/board/eSCaywkjIjoce79H3CzSnr)

## Módulos principais

- **`webhook/`** — recebe eventos do GitHub, valida a assinatura HMAC e dispara o pipeline.
- **`github/`** — wrapper da API do GitHub (PR, diff, conteúdo de arquivos, linguagens, comentários) com **retry e backoff exponencial**.
- **`analysis/`** — orquestra o pipeline: `analysis.service`, `llm.service`, `diff.service`, `shared-files.service`, `scoring.service`.
- **`rules/`** — CRUD de regras de revisão (regras padrão, globais e específicas por repositório).
- **`scoring-config/`** — pesos da pontuação por criticidade.
- **`comment/`** — formata o comentário em Markdown (PT-BR, com indicadores 🔴🟡🟢).
- **`repositories/`** — registro dos repositórios e webhooks.

## Regras de revisão

As regras ficam no banco (model `Rule`) e são combinadas por repositório em `RulesService.getActiveRulesForRepo`:

- **Padrão** (`isDefault`) — aplicadas a todos os repositórios e não podem ser editadas/removidas.
- **Globais customizadas** — sem associação a repositório específico (valem para todos).
- **Específicas** — associadas a um repositório via `RuleRepository`.

Cada regra tem `title`, `description`, `criticality` (`low`/`medium`/`high`), `fileGlobs` e `targetLanguage`.

De onde as regras vêm em uma instalação nova:

- **Regras padrão** — vivem em `prisma/seed.ts` (versionado); entram no banco com `npx prisma db seed`.
- **Regras aprovadas** — vivem em `data/approved-rules.json` (versionado); entram no banco com o script `scripts/approved-rules.ts` (ver [Importar as regras aprovadas](#6-importar-as-regras-aprovadas-opcional)). As regras específicas de repositório só são associadas a repositórios já registrados no banco.
- **Fonte enriquecida** — `data/approved-rules-enriched.json` é o artefato original do qual `approved-rules.json` foi derivado. Contém campos extras por regra (`whyThisRuleExists`, `localEvidence`, `externalSources`, `classification`) que ainda não são usados no prompt do LLM, mas são a base para evoluções futuras — não edite as regras só no derivado.
- **Regras criadas pelo dashboard** — ficam apenas no banco daquela instalação; não são versionadas.

## Pontuação

Definida em `ScoringService`: começa em **100** e desconta pesos por criticidade de cada issue (padrão: `high=10`, `medium=4`, `low=1`, configuráveis em `ScoringConfig`). Nunca fica abaixo de 0.

```
nota = max(0, 100 - Σ peso(criticidade))
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL (Prisma) |
| `GITHUB_APP_ID` | ID do GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Chave privada do GitHub App |
| `GITHUB_WEBHOOK_SECRET` | Segredo usado na validação HMAC do webhook |
| `GITHUB_ORG` | Organização alvo no GitHub |
| `WEBHOOK_URL` | URL base pública para registro do webhook |
| `OPENAI_API_KEY` | Chave da API da OpenAI |
| `OPENAI_MODEL` | Modelo usado (padrão: `gpt-4o`) |
| `MAX_DIFF_TOKENS` | Limite estimado de tokens por lote do diff (padrão: `12000`) |
| `PORT` | Porta da API (padrão: `3000`) |
| `API_USER` / `API_PASSWORD` | Credenciais do Basic Auth da API (também usadas no login do dashboard) |
| `SCORE_WEIGHT_HIGH` / `SCORE_WEIGHT_MEDIUM` / `SCORE_WEIGHT_LOW` | Pesos iniciais da pontuação (opcionais; padrão `10`/`4`/`1`) |
| `NEXT_PUBLIC_API_URL` | (webapp) URL da API que o dashboard consome |

Existe um `.env.example` na raiz com todas as variáveis — copie para `.env` e preencha. **Nunca versione o `.env` nem a chave `.pem`** (ambos já estão no `.gitignore`).

## Setup

```bash
$ npm install
$ npx prisma migrate dev     # aplica o schema no banco
$ npx prisma db seed         # popula regras padrão / config (opcional)
$ npm run webapp:install     # instala dependências do dashboard Next.js
```

## Executar

```bash
# desenvolvimento
$ npm run start

# watch mode
$ npm run start:dev

# produção
$ npm run start:prod
```

### Dashboard Web

```bash
$ npm run webapp:dev
```

O frontend fica em `webapp/` e, por padrão, espera a API do backend em `http://localhost:3000`. Quando necessário, configure `NEXT_PUBLIC_API_URL` no ambiente do app Next.

Para subir a versão já compilada do frontend:

```bash
$ npm run webapp:build
$ npm run webapp:start
```

## Testes

```bash
$ npm run test         # unitários
$ npm run test:e2e     # end-to-end
$ npm run test:cov     # cobertura
```

## Resiliência

Todas as chamadas externas (GitHub e OpenAI) usam retry com backoff exponencial. Erros de rate-limit (`429`) e de servidor (`5xx`) são re-tentados automaticamente; erros de autenticação (`401`/`403`) não. Quando a OpenAI rejeita um prompt grande demais, o `LlmService` agora remove o contexto compartilhado e divide o lote em partes menores antes de desistir. Se o pipeline ainda falhar, um comentário de erro é publicado no PR.

## Deploy em produção

O PRzator precisa de **três coisas rodando**: a API NestJS (com URL pública HTTPS, para o GitHub conseguir entregar os webhooks), um **PostgreSQL** e, opcionalmente, o **dashboard Next.js**. Qualquer host serve — VPS com Docker, Railway, Render, Fly.io etc.

### Pré-requisitos

- Node.js 20+ e PostgreSQL 14+
- Um domínio/URL pública com HTTPS apontando para a API (ex.: `https://przator.suaempresa.com`)
- Chave da OpenAI com billing ativo
- Permissão de admin na organização do GitHub para criar um **GitHub App**

### 1. Criar o GitHub App na organização

Em **Settings → Developer settings → GitHub Apps → New GitHub App** (na conta/organização da empresa, não na pessoal):

- **Webhook URL**: `https://SEU_DOMINIO/webhook/github`
- **Webhook secret**: gere um valor aleatório forte (ex.: `openssl rand -hex 32`) — será o `GITHUB_WEBHOOK_SECRET`
- **Permissions**: Pull requests (Read & write), Contents (Read-only), Metadata (Read-only), Issues (Read & write — para publicar comentários)
- **Subscribe to events**: Pull request
- Depois de criar: anote o **App ID** (`GITHUB_APP_ID`), gere uma **private key** (o conteúdo do `.pem` vai em `GITHUB_APP_PRIVATE_KEY`) e **instale o App** nos repositórios que serão revisados (aba *Install App*).

> Cada ambiente (dev, prod da empresa) tem o **seu próprio** GitHub App, com sua própria chave e secret. O App usado em desenvolvimento não vai para a empresa.

### 2. Banco de dados

```bash
npx prisma migrate deploy   # aplica as migrations (produção — não usar migrate dev)
npx prisma db seed          # popula regras padrão e config de pontuação
```

### 3. Configurar o ambiente

```bash
cp .env.example .env        # e preencher com os valores de produção
```

Pontos de atenção:
- `WEBHOOK_URL` = URL pública da API (sem path), usada ao registrar webhooks de repositório.
- `GITHUB_APP_PRIVATE_KEY` = conteúdo do `.pem` (multi-linha, entre aspas).
- `API_USER`/`API_PASSWORD` = defina credenciais fortes; são o login do dashboard.

### 4. Build e execução

```bash
npm ci
npm run build
npm run start:prod          # API na porta $PORT (padrão 3000)

# dashboard (opcional, pode rodar em outro host)
npm run webapp:install
NEXT_PUBLIC_API_URL=https://SEU_DOMINIO npm run webapp:build
npm run webapp:start
```

Em produção use um gerenciador de processos (systemd, PM2 ou Docker) para manter a API no ar e reiniciá-la em caso de falha.

### 5. Registrar os repositórios

Com a API no ar e o App instalado nos repositórios, cadastre cada repositório pelo dashboard (ou via `POST /repos` com Basic Auth). O PRzator cria o webhook do repositório apontando para `WEBHOOK_URL` automaticamente.

### 6. Importar as regras aprovadas (opcional)

O seed cria só as regras padrão. O conjunto completo de regras aprovadas está em `data/approved-rules.json` e é importado com o script `scripts/approved-rules.ts` — **depois** de registrar os repositórios (o import associa regras específicas aos repositórios do banco e aborta se algum não for resolvido):

```bash
export APPROVED_RULES_PATH=./data/approved-rules.json
export IMPORT_RULES_PATH=./data/import-rules.json
export IMPORT_MANIFEST_PATH=./data/import-manifest.json

npm run rules:dry-run:approved   # simula e mostra o que seria importado
npm run rules:import:approved    # importa de fato
```

O nome de cada repositório no banco precisa bater com o `sourceRepo` das regras — o `dry-run` mostra os não resolvidos antes de importar. `LOCAL_REPOS_ROOT` (validação de globs contra clones locais) é opcional — sem ele, a validação de amostras só fica vazia.

### 7. Validar

1. Abra um PR de teste em um repositório registrado.
2. Confira nos logs da API que o webhook chegou e o pipeline rodou.
3. O comentário com a nota deve aparecer no PR em alguns minutos.

### Checklist de produção

- [ ] GitHub App criado **na organização da empresa**, instalado nos repositórios-alvo
- [ ] `.env` preenchido no servidor (nunca commitado)
- [ ] `prisma migrate deploy` + `db seed` executados
- [ ] Regras aprovadas importadas (`rules:import:approved`) após registrar os repositórios
- [ ] URL pública HTTPS respondendo em `/webhook/github`
- [ ] `API_USER`/`API_PASSWORD` fortes (o dashboard fica exposto na internet)
- [ ] Backup do PostgreSQL configurado
- [ ] Limite de gasto (budget) configurado na conta OpenAI
- [ ] PR de teste analisado com sucesso
