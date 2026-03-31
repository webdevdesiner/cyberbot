require('dotenv').config();
const path = require('path');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const CONHECIMENTO = require('./conhecimento');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('Erro: Configure a GEMINI_API_KEY no arquivo .env');
  process.exit(1);
}

// ========== CONFIG ==========
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SILENT_MODE = true;
const ENABLE_AGENTE_PISCINA = true;
const ENABLE_AGENTE_IMPORTADOS = true;
const ENABLE_OFFLINE_CATCHUP = false;
const TEST_ONLY_NICHO = null;
const FORNECEDOR_IPHONE = '595994126060@c.us';
const GOOGLE_DOCS_URL = 'https://docs.google.com/document/d/1W_Z4NnWNGU17PZX1_e10OhPUwaIwhaZ9Tnejp2HPdwk/export?format=txt';
let catalogoIphones = `💥 iPhone 12 – 128GB
💲 $225 – Lilás

💥 iPhone 13 – 128GB
💲 $310 – Branco
💲 $310 – Pink
💲 $310 – Verde

💥 iPhone 14 – 128GB
💲 $335 – Preto
💲 $335 – Azul
💲 $335 – Lilás
💲 $335 – Branco

💥 iPhone 13 Pro – 128GB
💲 $400 – Gold
💲 $400 – Azul
💲 $400 – Preto
💲 $400 – Silver

💥 iPhone 13 Pro Max – 128GB
💲 $425 – Gold
💲 $425 – Silver
💲 $425 – Preto
💲 $425 – Azul

💥 iPhone 13 Pro – 256GB
💲 $450 – Azul

💥 iPhone 15 – 128GB
💲 $450 – Pink
💲 $450 – Preto
💲 $450 – Green

💥 iPhone 14 Pro Max – 128GB
💲 $500 – Preto
💲 $500 – Gold
💲 $500 – Lilás
💲 $500 – Silver

💥 iPhone 16 – 128GB (Grad A+)
💲 $600 – Black
💲 $600 – Branco
💲 $600 – Pink
💲 $600 – Azul
💲 $600 – Verde

💥 iPhone 15 Pro Max – 256GB
💲 $655 – Azul
💲 $655 – Branco
💲 $655 – Natural
💲 $655 – Preto

💥 iPhone 16 Pro – 128GB
💲 $715 – Gold
💲 $715 – Preto

💥 iPhone 15 Pro Max – 512GB
💲 $720 – Natural
💲 $720 – Branco
💲 $720 – Azul
💲 $720 – Preto

💥 iPhone 16 Pro Max – 256GB
💲 $870 – Preto
💲 $870 – Gold
💲 $870 – Branco
💲 $870 – Natural`;
const WHATSAPP_SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'cyberbot-5518996090837';
const DB_FILE = path.join(__dirname, 'orion.db');
const PORT = Number(process.env.PORT) || 3000;

const CYBERBOT_OBSERVADOR_PROMPT = String(CONHECIMENTO.CYBERBOT_OBSERVADOR_ANALITICO || '').trim();
const MEU_PERFIL_PROFISSIONAL_PROMPT = JSON.stringify(CONHECIMENTO.MEU_PERFIL_PROFISSIONAL || {}, null, 2);

const TERMOS_COMERCIAIS = [
  'preço',
  'valor',
  'quanto',
  'estoque',
  'disponível',
  'entrega',
  'frete',
  'orçamento',
  'logo',
  'site',
  'app',
  'piscina',
  'diária',
  'reserva',
  'aluguel',
  'dólar',
  'cotacao',
  'u$',
  'r$'
];

const TERMOS_LOCACAO_TESTE = [
  'piscina', 'diaria', 'diária', 'reserva', 'aluguel', 'locacao', 'locação',
  'lazer', 'casa', 'espaco', 'espaço', 'disponibilidade', 'chacara', 'chácara',
  'rancho', 'festa', 'evento', 'aniversario', 'aniversário', 'confraternizacao',
  'churrasco', 'fim de semana', 'final de semana', 'fds', 'sabado', 'sábado',
  'domingo', 'feriado', 'vaga', 'livre', 'data', 'agendar', 'agenda',
  'carnaval', 'natal', 'ano novo'
];

const TERMOS_COMERCIAIS_NORMALIZADOS = TERMOS_COMERCIAIS.map(normalizeToken);
const TERMOS_LOCACAO_TESTE_NORMALIZADOS = TERMOS_LOCACAO_TESTE.map(normalizeToken);

let db = null;
// Memória temporária para roteamento de agentes (limpa ao reiniciar)
const activeSessions = new Map();

// ========== IA ==========
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: GEMINI_MODEL }, { apiVersion: 'v1beta' });
const GEMINI_RETRY_ATTEMPTS = 2; // além da primeira tentativa
const GEMINI_RETRY_BASE_DELAY_MS = 900;

// ========== WHATSAPP ==========
const client = new Client({
  authStrategy: new LocalAuth({ clientId: WHATSAPP_SESSION_ID }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

client.on('qr', (qr) => {
  console.log('🤖 Escaneie o QR Code no WhatsApp.');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  const wid = client.info?.wid?.user || '?';
  console.log(`✅ Cyberbot conectado | sessão=${WHATSAPP_SESSION_ID} | wid=${wid}`);
  if (ENABLE_OFFLINE_CATCHUP) {
    console.log('[Cyberbot ⏳] Catch-up offline ativo.');
  } else {
    console.log('[Cyberbot ⏳] Catch-up offline desativado (tempo real apenas).');
  }
});

// ========== HELPERS ==========
function normalizeToken(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function normalizeLearningCategory(raw) {
  const c = String(raw || '').trim();
  if (c === 'Fornecedor' || c === 'Cliente' || c === 'Casual') return c;
  const lower = c.toLowerCase();
  if (lower.includes('fornec')) return 'Fornecedor';
  if (lower.includes('client')) return 'Cliente';
  return 'Casual';
}

function normalizeLearningNicho(raw) {
  const allowed = new Set(['DESIGN_DEV', 'IMPORTADOS', 'VESTUARIO', 'LOCACAO', 'OUTROS']);
  const value = String(raw || '').trim().toUpperCase();
  return allowed.has(value) ? value : 'OUTROS';
}

function normalizeSupplierSubtype(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (value === 'DROPSHIPPING_BR' || value === 'PARAGUAI_DOLLAR') return value;
  return null;
}

function parsePriceNumberLoose(val) {
  if (val == null) return null;
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const s = String(val).trim().replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function hasCommercialKeyword(text) {
  const normalized = normalizeToken(text);
  return TERMOS_COMERCIAIS_NORMALIZADOS.some((termo) => normalized.includes(termo));
}

function hasLocacaoKeyword(text) {
  const normalized = normalizeToken(text);
  return TERMOS_LOCACAO_TESTE_NORMALIZADOS.some((termo) => normalized.includes(termo));
}

function hasAnyNumber(text) {
  return /\d/.test(String(text || ''));
}

function hasImportadosKeyword(text) {
  const normalized = normalizeToken(text);
  const termos = [
    'iphone',
    'celular',
    'celulares',
    'smartphone',
    'paraguai',
    'eletronico',
    'eletronicos',
    'ipad',
    'macbook',
    'apple'
  ];
  return termos.some((termo) => normalized.includes(termo));
}

function isGemini503Error(err) {
  const msg = String(err?.message || err || '');
  return msg.includes('[503') || msg.includes('503 Service Unavailable') || msg.includes('Service Unavailable');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withFuturisticIntro(replyText, isFirstMessageInSession) {
  const base = String(replyText || '').trim();
  if (!base) return base;
  if (!isFirstMessageInSession) return base;
  return `🤖 Sou o assistente virtual do Fernando. ${base}`;
}

function formatDatePtBr(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = String(date.getFullYear());
  return `${dd}/${mm}/${yyyy}`;
}

function inferRelativeDateHint(userMessage) {
  const text = normalizeToken(userMessage);
  const now = new Date();

  const plusDays = (days) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    return d;
  };

  // Prioridade para "depois de amanhã" antes de "amanhã"
  if (text.includes('depois de amanha')) {
    const target = plusDays(2);
    return `Data relativa detectada no texto do cliente: "depois de amanhã" = ${formatDatePtBr(target)}.`;
  }
  if (text.includes('amanha')) {
    const target = plusDays(1);
    return `Data relativa detectada no texto do cliente: "amanhã" = ${formatDatePtBr(target)}.`;
  }
  if (text.includes('hoje')) {
    return `Data relativa detectada no texto do cliente: "hoje" = ${formatDatePtBr(now)}.`;
  }
  return '';
}

async function withGeminiRetry(operationName, fn) {
  let lastErr = null;
  const totalTries = 1 + GEMINI_RETRY_ATTEMPTS;
  for (let attempt = 1; attempt <= totalTries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isGemini503Error(err) || attempt >= totalTries) break;
      const backoff = GEMINI_RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[Gemini Retry] ${operationName} tentativa ${attempt}/${totalTries} falhou com 503. Nova tentativa em ${backoff}ms.`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function shouldProcessLearningMessage({ msg, chatId, userMessage }) {
  const body = String(userMessage || '').trim();
  if (body.length <= 3) return false;

  // 🚨 TRAVA ANTI-GRUPOS: Ignora silenciosamente qualquer mensagem de grupo
  if (String(chatId || '').endsWith('@g.us')) {
    return false;
  }

  if (TEST_ONLY_NICHO === 'LOCACAO') return hasLocacaoKeyword(body);
  if (msg?.fromMe) return true;

  const hasKeyword = hasCommercialKeyword(body);
  const hasNumber = hasAnyNumber(body);
  return hasKeyword || hasNumber;
}

function parseResumoNichoFilter(userText) {
  const raw = String(userText || '').trim();
  const match = raw.match(/^!resumo(?:\s+([A-Za-z_]+))?/i);
  const token = String(match?.[1] || '').trim().toUpperCase();
  return token ? normalizeLearningNicho(token) : null;
}

function getCyberbotStatusText() {
  const wa = client.info?.wid?._serialized ? 'conectado' : 'aguardando sessão';
  return [
    '*Cyberbot* — observador',
    `SILENT_MODE: ${SILENT_MODE}`,
    `Nicho de teste: ${TEST_ONLY_NICHO || 'desligado'}`,
    `Catch-up offline: ${ENABLE_OFFLINE_CATCHUP}`,
    'Comandos: *!status* | *!resumo* | *!resumo <NICHO>*',
    `WhatsApp: ${wa}`,
    `Modelo IA: ${GEMINI_MODEL}`,
    `SQLite: ${path.basename(DB_FILE)}`
  ].join('\n');
}

// ========== DB ==========
async function initDatabase() {
  db = await open({ filename: DB_FILE, driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS learning_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      whatsapp_msg_id TEXT,
      category TEXT NOT NULL,
      nicho TEXT NOT NULL DEFAULT 'OUTROS',
      supplier_subtype TEXT,
      raw_content TEXT,
      processed_insight TEXT,
      price_calculated REAL,
      deal_closed INTEGER NOT NULL DEFAULT 0,
      revenue REAL,
      priority INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1, 2, 3)),
      archived INTEGER NOT NULL DEFAULT 0
    );
  `);

  const migrations = [
    `ALTER TABLE learning_data ADD COLUMN whatsapp_msg_id TEXT`,
    `ALTER TABLE learning_data ADD COLUMN nicho TEXT NOT NULL DEFAULT 'OUTROS'`,
    `ALTER TABLE learning_data ADD COLUMN supplier_subtype TEXT`,
    `ALTER TABLE learning_data ADD COLUMN deal_closed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE learning_data ADD COLUMN revenue REAL`,
    `ALTER TABLE learning_data ADD COLUMN priority INTEGER NOT NULL DEFAULT 2`,
    `ALTER TABLE learning_data ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`
  ];
  for (const sql of migrations) {
    try {
      await db.run(sql);
    } catch (err) {
      if (!String(err?.message || '').includes('duplicate column name')) throw err;
    }
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_learning_data_whatsapp_msg_id ON learning_data(whatsapp_msg_id);
    CREATE INDEX IF NOT EXISTS idx_learning_data_timestamp_nicho ON learning_data(timestamp, nicho);
    CREATE INDEX IF NOT EXISTS idx_learning_data_supplier_subtype ON learning_data(supplier_subtype);
  `);
}

async function insertLearningRow({
  senderId,
  whatsappMsgId = null,
  sourceTimestampIso = null,
  category,
  nicho,
  supplierSubtype = null,
  rawContent,
  insight,
  priceCalculated
}) {
  const ts = sourceTimestampIso && !Number.isNaN(Date.parse(sourceTimestampIso))
    ? sourceTimestampIso
    : new Date().toISOString();

  await db.run(
    `INSERT INTO learning_data (
      timestamp, sender_id, whatsapp_msg_id, category, nicho, supplier_subtype,
      raw_content, processed_insight, price_calculated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ts,
      String(senderId || ''),
      whatsappMsgId ? String(whatsappMsgId) : null,
      category,
      nicho,
      supplierSubtype,
      String(rawContent || ''),
      String(insight || ''),
      priceCalculated != null && Number.isFinite(Number(priceCalculated)) ? Number(priceCalculated) : null
    ]
  );
}

// ========== CLASSIFICACAO ==========
async function classifyMessageForLearning(rawUserText) {
  const body = String(rawUserText || '').trim();
  if (!body) return null;

  const instrucao = `
${CYBERBOT_OBSERVADOR_PROMPT}

Responda com JSON válido e nada além do JSON.

Categorias:
- category: "Fornecedor" | "Cliente" | "Casual"
- nicho: "DESIGN_DEV" | "IMPORTADOS" | "VESTUARIO" | "LOCACAO" | "OUTROS"
- supplier_subtype: "DROPSHIPPING_BR" | "PARAGUAI_DOLLAR" | null

Nicho LOCACAO:
- Identifique como LOCACAO qualquer pedido de reserva de data, consulta de disponibilidade para lazer,
  aluguel de espaço por dia ou perguntas sobre a piscina do Fernando em Presidente Prudente.

Preço:
- extracted_price_brl: número ou null.
- Se houver múltiplos valores, extraia o preço unitário de venda.
- Ignore números que pareçam SKU, telefone, CEP ou datas.
- Para fornecedor PARAGUAI_DOLLAR mantenha extração numérica quando possível.

Retorne no formato:
{"category":"Fornecedor|Cliente|Casual","nicho":"DESIGN_DEV|IMPORTADOS|VESTUARIO|LOCACAO|OUTROS","supplier_subtype":"DROPSHIPPING_BR|PARAGUAI_DOLLAR|null","insight":"...","extracted_price_brl":null}

Perfil profissional de contexto:
${MEU_PERFIL_PROFISSIONAL_PROMPT}

Mensagem:
${body}
`.trim();

  try {
    const result = await withGeminiRetry('classifyMessageForLearning', () => model.generateContent(instrucao));
    const raw = (result.response?.text?.() || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);

    const category = normalizeLearningCategory(parsed?.category);
    const nicho = normalizeLearningNicho(parsed?.nicho);
    const supplierSubtype = category === 'Fornecedor' ? normalizeSupplierSubtype(parsed?.supplier_subtype) : null;
    const insight = String(parsed?.insight || '').trim() || '(sem resumo)';

    let priceCalculated = null;
    if (category === 'Fornecedor') {
      const extracted = parsePriceNumberLoose(parsed?.extracted_price_brl);
      if (extracted != null) {
        // TODO: Criar conversão de câmbio para PARAGUAI_DOLLAR.
        priceCalculated = (extracted + 20) * 1.3;
      }
    }
    return { category, nicho, supplierSubtype, insight, priceCalculated };
  } catch (err) {
    console.warn('[Learning] Falha na classificação:', err?.message || err);
    return { category: 'Casual', nicho: 'OUTROS', supplierSubtype: null, insight: 'Classificação indisponível.', priceCalculated: null };
  }
}

async function recordLearningFromText(senderId, rawUserText, opts = {}) {
  const analyzed = await classifyMessageForLearning(rawUserText);
  if (!analyzed) return null;
  if (TEST_ONLY_NICHO && analyzed.nicho !== TEST_ONLY_NICHO) {
    console.log('[Cyberbot 🛡️ Filtro] Mensagem ignorada (fora do nicho de teste).');
    return null;
  }

  await insertLearningRow({
    senderId,
    whatsappMsgId: opts.whatsappMsgId || null,
    sourceTimestampIso: opts.sourceTimestampIso || null,
    category: analyzed.category,
    nicho: analyzed.nicho,
    supplierSubtype: analyzed.supplierSubtype,
    rawContent: rawUserText,
    insight: analyzed.supplierSubtype ? `${analyzed.insight} (Subtipo fornecedor: ${analyzed.supplierSubtype})` : analyzed.insight,
    priceCalculated: analyzed.priceCalculated
  });

  const insightLog = analyzed.insight.length > 140 ? `${analyzed.insight.slice(0, 137)}...` : analyzed.insight;
  console.log(`[Cyberbot 🧠] Novo aprendizado: Categoria=${analyzed.category} | Nicho=${analyzed.nicho} | Insight=${insightLog}`);
  return analyzed;
}

async function getCyberbotResumoText(nichoFilter = null) {
  const normalizedFilter = nichoFilter ? normalizeLearningNicho(nichoFilter) : null;
  const rows = normalizedFilter
    ? await db.all(
        `SELECT id, timestamp, sender_id, category, nicho, processed_insight, price_calculated
         FROM learning_data WHERE nicho = ? ORDER BY id DESC LIMIT 5`,
        [normalizedFilter]
      )
    : await db.all(
        `SELECT id, timestamp, sender_id, category, nicho, processed_insight, price_calculated
         FROM learning_data ORDER BY id DESC LIMIT 5`
      );

  if (!rows.length) return normalizedFilter
    ? `*Cyberbot* — Nenhum registro recente para *${normalizedFilter}*.`
    : '*Cyberbot* — Nenhum registro em learning_data.';

  if (normalizedFilter) {
    const lines = rows.map((r, i) =>
      `- ${i + 1}) _${String(r.timestamp).replace('T', ' ').slice(0, 19)}_ | ${r.category} | ${r.sender_id}\n  Insight: ${r.processed_insight}\n  Preço calc.: ${r.price_calculated != null ? `R$ ${Number(r.price_calculated).toFixed(2)}` : '—'}`
    );
    return [`📋 *Últimos 5 — ${normalizedFilter}*`, '', ...lines].join('\n');
  }

  const groups = rows.reduce((acc, r) => {
    const k = normalizeLearningNicho(r.nicho);
    if (!acc[k]) acc[k] = [];
    acc[k].push(r);
    return acc;
  }, {});

  const ordered = ['DESIGN_DEV', 'IMPORTADOS', 'VESTUARIO', 'LOCACAO', 'OUTROS'];
  const out = ['📋 *Últimos 5 aprendizados (agrupados por nicho)*', ''];
  for (const k of ordered) {
    if (!groups[k]?.length) continue;
    out.push(`*${k}*`);
    groups[k].forEach((r, i) => {
      out.push(`- ${i + 1}) _${String(r.timestamp).replace('T', ' ').slice(0, 19)}_ | ${r.category} | ${r.sender_id}`);
      out.push(`  Insight: ${r.processed_insight}`);
    });
    out.push('');
  }
  return out.join('\n').trim();
}

async function handlePiscinaAgent(chatId, userMessage) {
  if (!ENABLE_AGENTE_PISCINA) {
    console.log(`[Agente Piscina 🛑] Atendimento bloqueado (ENABLE_AGENTE_PISCINA = false). Lead: ${chatId}`);
    return;
  }

  const session = activeSessions.get(chatId) || { department: 'PISCINA', history: [] };
  session.department = 'PISCINA';
  session.history.push({ role: 'user', parts: [{ text: userMessage }] });
  const isFirstMessageInSession = session.history.length <= 1;

  let infoAgenda = 'Aviso ao bot: Não foi possível carregar a agenda. Diga ao cliente que você precisa confirmar com o Fernando.';
  try {
    const resp = await axios.get('https://darkgoldenrod-snake-457682.hostingersite.com/api_agenda.php', { timeout: 4000 });
    if (Array.isArray(resp.data)) {
      if (resp.data.length > 0) {
        infoAgenda = `[DADOS DE AGENDA EM TEMPO REAL]: Atenção, as seguintes datas JÁ ESTÃO OCUPADAS: ${resp.data.join(', ')}. QUALQUER OUTRA DATA ESTÁ LIVRE.`;
      } else {
        infoAgenda = '[DADOS DE AGENDA EM TEMPO REAL]: Todas as datas da agenda estão LIVRES.';
      }
    }
  } catch (err) {
    console.warn('[Agente Piscina ⚠️] Falha ao ler agenda da Hostinger:', err.message);
  }

  const dateRef = formatDatePtBr(new Date());
  const relativeDateHint = inferRelativeDateHint(userMessage);
  const promptComAgenda = `${CONHECIMENTO.PROMPT_AGENTE_PISCINA || ''}

[REFERÊNCIA DE DATA]
Hoje é ${dateRef}. Interprete termos relativos do cliente com base nessa data (ex.: "amanhã", "depois de amanhã", "hoje").
${relativeDateHint ? `${relativeDateHint}\n` : ''}${infoAgenda}`;

  try {
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: promptComAgenda }] },
        { role: 'model', parts: [{ text: 'Entendido. Estou pronto para atender.' }] },
        ...session.history.slice(-6)
      ]
    });

    const result = await withGeminiRetry('handlePiscinaAgent', () => chat.sendMessage(`Responda ao cliente: ${userMessage}`));
    const rawReplyText = String(result.response?.text?.() || '').trim();
    const replyText = withFuturisticIntro(rawReplyText, isFirstMessageInSession);
    if (!replyText) return;

    session.history.push({ role: 'model', parts: [{ text: replyText }] });
    activeSessions.set(chatId, session);

    // 1. Verifica se a IA solicitou o envio de fotos
    if (replyText.includes('[ENVIAR_FOTOS]')) {
      const cleanedReply = replyText.replace('[ENVIAR_FOTOS]', '').trim();
      await client.sendMessage(chatId, cleanedReply);

      const photosToSend = [
        'piscina_geral.jpeg',
        'piscina.jpeg',
        'churrasqueira.jpeg',
        'quarto.jpeg'
      ];

      console.log(`[Agente Piscina 🖼️] Carregando fotos para ${chatId}...`);
      for (const photoName of photosToSend) {
        try {
          const media = MessageMedia.fromFilePath(`./fotos_piscina/${photoName}`);
          await client.sendMessage(chatId, media);
          await new Promise((resolve) => setTimeout(resolve, 800));
        } catch (mediaErr) {
          console.error(`[Agente Piscina ⚠️] Erro ao enviar foto ${photoName}:`, mediaErr.message);
        }
      }
      console.log(`[Agente Piscina 🏊‍♂️+🖼️] Texto e fotos enviados para ${chatId}`);
    } else {
      await client.sendMessage(chatId, replyText);
      console.log(`[Agente Piscina 🏊‍♂️] Respondido para ${chatId}`);
    }
  } catch (err) {
    console.error('[Agente Piscina 🏊‍♂️] Erro ao responder:', err?.message || err);
    try {
      await client.sendMessage(
        chatId,
        'Estou com uma instabilidade rápida aqui no sistema, mas já vou continuar seu atendimento. Se puder, me mande novamente sua última mensagem em instantes.'
      );
    } catch (sendErr) {
      console.error('[Agente Piscina 🏊‍♂️] Falha ao enviar mensagem de fallback:', sendErr?.message || sendErr);
    }
  }
}

async function getCatalogoConvertido() {
  try {
    // 1. Busca a cotação do dólar
    const respDolar = await axios.get('https://economia.awesomeapi.com.br/last/USD-BRL', { timeout: 4000 });
    const dolarComercial = parseFloat(respDolar.data.USDBRL.ask);
    const dolarParaguai = dolarComercial * 1.03; // Spread de 3%

    // 2. Busca o catálogo do Google Docs
    let catalogoDocs = '';
    try {
      const respDocs = await axios.get(GOOGLE_DOCS_URL, { timeout: 6000 });
      catalogoDocs = respDocs.data;
    } catch (errDocs) {
      console.warn('[Agente Importados ⚠️] Falha ao ler Google Docs:', errDocs.message);
      catalogoDocs = '\n(Aviso: Lista estendida temporariamente indisponível)\n';
    }

    // 3. Junta as duas listas (WhatsApp + Docs)
    const catalogoCompleto = `*📱 CATÁLOGO WHATSAPP*\n\n${catalogoIphones}\n\n➖➖➖➖➖➖➖➖\n\n*🎮 CATÁLOGO STARGAMES (DOCS)*\n\n${catalogoDocs}`;

    // 4. Converte os preços (Lida com decimais e milhares misturados)
    const catalogoBRL = catalogoCompleto.replace(/\$\s*([\d.,]+)/g, (match, valorDolar) => {
      let numeroStr = valorDolar.trim();

      // Se tiver ponto e exatamente dois dígitos no final, é centavo (ex: 127.50)
      if (numeroStr.includes('.') && numeroStr.split('.').pop().length === 2) {
        numeroStr = numeroStr.replace(/,/g, ''); // Remove vírgulas de milhar se houver
      } else {
        // Se não, é milhar (remove todos os pontos e vírgulas, ex: 1,365 ou 1.355)
        numeroStr = numeroStr.replace(/[,.]/g, '');
      }

      const numeroLimpo = parseFloat(numeroStr);
      if (Number.isNaN(numeroLimpo)) return match;

      const precoFinal = Math.ceil((numeroLimpo * dolarParaguai) * 1.20);
      return `R$ ${precoFinal},00`;
    });

    return `[Dólar Oficial: R$ ${dolarComercial.toFixed(2)} | Dólar Loja (+3%): R$ ${dolarParaguai.toFixed(2)}]\n\n${catalogoBRL}`;
  } catch (err) {
    console.error('[Agente Importados ⚠️] Erro Geral:', err.message);
    return 'Aviso IA: O sistema do dólar está fora do ar. Diga ao cliente que estamos atualizando a tabela de preços e peça para ele aguardar o Fernando.';
  }
}

async function handleImportadosAgent(chatId, userMessage) {
  if (!ENABLE_AGENTE_IMPORTADOS) return;
  const session = activeSessions.get(chatId) || { department: 'IMPORTADOS', history: [] };
  session.department = 'IMPORTADOS';
  session.history.push({ role: 'user', parts: [{ text: userMessage }] });
  const isFirstMessageInSession = session.history.length <= 1;

  const catalogoPronto = await getCatalogoConvertido();
  const PROMPT_IMPORTADOS = `
Você é o assistente de vendas de iPhones do Fernando.
Seu objetivo é fechar vendas de forma simpática e direta.
Tabela em Reais (Preço Final):
${catalogoPronto}

REGRAS:
1. Responda de forma curta e natural.
2. NUNCA mencione Paraguai, Swap, taxas, dólar ou lucro. Diga apenas que são "Originais e impecáveis (vitrine)".
3. Informe o preço diretamente se o cliente perguntar de um modelo da lista.
4. Se pedir um modelo fora da lista, diga que vai checar o estoque central.
  `;

  try {
    const chat = model.startChat({
      history: [
        { role: 'user', parts: [{ text: PROMPT_IMPORTADOS }] },
        { role: 'model', parts: [{ text: 'Entendido. Pronto para vender.' }] },
        ...session.history.slice(-6)
      ]
    });

    const result = await withGeminiRetry('handleImportadosAgent', () => chat.sendMessage(`Responda ao cliente: ${userMessage}`));
    const rawReplyText = String(result.response?.text?.() || '').trim();
    const replyText = withFuturisticIntro(rawReplyText, isFirstMessageInSession);
    if (!replyText) return;

    session.history.push({ role: 'model', parts: [{ text: replyText }] });
    activeSessions.set(chatId, session);

    await client.sendMessage(chatId, replyText);
    console.log(`[Agente Importados 📱] Respondido para ${chatId}`);
  } catch (err) {
    console.error('[Agente Importados ⚠️] Erro:', err.message);
  }
}

// ========== MENSAGENS ==========
client.on('message', async (msg) => {
  const chatId = msg?.from || '';
  if (!chatId) return;
  if (chatId === 'status@broadcast' || chatId.endsWith('@newsletter')) return;

  const rawBody = typeof msg?.body === 'string' ? msg.body : '';
  const userMessage = rawBody.trim();

  if (chatId === FORNECEDOR_IPHONE) {
    catalogoIphones = userMessage;
    console.log('[Agente Importados 📱] Novo catálogo atualizado!');
  }

  if (!userMessage && !msg.hasMedia) return;

  if (userMessage && /^\s*!status(\b|\s|$)/i.test(userMessage)) {
    await client.sendMessage(chatId, getCyberbotStatusText());
    return;
  }
  if (userMessage && /^\s*!resumo(\b|\s|$)/i.test(userMessage)) {
    const filter = parseResumoNichoFilter(userMessage);
    const text = await getCyberbotResumoText(filter);
    await client.sendMessage(chatId, text);
    return;
  }
  if (userMessage && /^\s*!catalogo(\b|\s|$)/i.test(userMessage)) {
    try {
      const isRaw = /^\s*!catalogo\s+raw(\b|\s|$)/i.test(userMessage);
      const catalogoConvertido = await getCatalogoConvertido();

      if (isRaw) {
        await client.sendMessage(chatId, `*💵 CATÁLOGO ORIGINAL (USD)*\n\n${catalogoIphones}\n\n➖➖➖➖➖➖➖➖\n\n*📦 CATÁLOGO CONVERTIDO (BRL)*\n\n${catalogoConvertido}`);
      } else {
        await client.sendMessage(chatId, `*📦 CATÁLOGO ATUAL*\n\n${catalogoConvertido}`);
      }
    } catch (err) {
      await client.sendMessage(chatId, `Erro ao gerar catálogo: ${err.message}`);
    }
    return;
  }

  if (!userMessage) return;

  // 1. Verifica se o cliente já possui um "Crachá VIP" (sessão em andamento)
  const activeSession = activeSessions.get(chatId) || null;
  const isSessionActive = Boolean(activeSession);

  // 2. Só aplica o filtro rígido se o cliente NÃO estiver em sessão
  const shouldProcess = isSessionActive || shouldProcessLearningMessage({ msg, chatId, userMessage });

  if (!shouldProcess) {
    console.log('[Cyberbot 🛡️ Filtro] Mensagem ignorada (sem relevância comercial e fora de sessão).');
    return;
  }

  let senderForLearning = msg.author || msg.from;
  if (msg.fromMe) {
    senderForLearning = 'eu';
  } else {
    try {
      const contact = await msg.getContact();
      const contactName = contact.name || contact.pushname || 'Cliente';
      const contactNumber = String(contact.number || senderForLearning || '')
        .replace('@c.us', '')
        .replace('@lid', '')
        .replace('@g.us', '');
      senderForLearning = `${contactName} (${contactNumber})`;
    } catch (err) {
      console.warn('[Contact] Não foi possível buscar o nome do contato:', err.message);
    }
  }
  const msgTsIso = msg?.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null;

  // 1) Se já está em sessão, roteia direto para o departamento correto.
  if (isSessionActive) {
    const analyzedInSession = await recordLearningFromText(senderForLearning, userMessage, {
      whatsappMsgId: msg?.id?._serialized || msg?.id?.id || null,
      sourceTimestampIso: msgTsIso
    });
    if (msg.fromMe) return;

    const currentDept = String(activeSession?.department || 'PISCINA').toUpperCase();
    let targetDept = currentDept;

    // Alternância flexível: permite migrar de um departamento para outro pela intenção da mensagem.
    if (analyzedInSession && analyzedInSession.nicho === 'LOCACAO' && (analyzedInSession.category === 'Cliente' || analyzedInSession.category === 'Casual')) {
      targetDept = 'PISCINA';
    } else if (analyzedInSession && analyzedInSession.nicho === 'IMPORTADOS' && (analyzedInSession.category === 'Cliente' || analyzedInSession.category === 'Casual')) {
      targetDept = 'IMPORTADOS';
    } else {
      // Fallback determinístico por palavras-chave quando a IA vier ambígua
      if (hasImportadosKeyword(userMessage)) targetDept = 'IMPORTADOS';
      else if (hasLocacaoKeyword(userMessage)) targetDept = 'PISCINA';
    }

    if (targetDept !== currentDept) {
      activeSessions.set(chatId, { department: targetDept, history: [] });
      console.log(`[Roteador 🔁] Lead ${chatId} alternado de ${currentDept} para ${targetDept}.`);
    }

    if (targetDept === 'IMPORTADOS') {
      await handleImportadosAgent(chatId, userMessage);
    } else {
      await handlePiscinaAgent(chatId, userMessage);
    }
    return;
  }

  // 2) Classifica/observa normalmente.
  const analyzed = await recordLearningFromText(senderForLearning, userMessage, {
    whatsappMsgId: msg?.id?._serialized || msg?.id?.id || null,
    sourceTimestampIso: msgTsIso
  });

  // 3) Se lead de locação (Cliente ou Casual), inicia sessão e encaminha ao agente.
  // Evita auto-resposta em mensagens próprias.
  if (analyzed && !msg.fromMe && analyzed.nicho === 'LOCACAO' && (analyzed.category === 'Cliente' || analyzed.category === 'Casual')) {
    activeSessions.set(chatId, { department: 'PISCINA', history: [] });
    console.log(`[Roteador 🔀] Lead ${chatId} encaminhado para o Departamento PISCINA.`);
    await handlePiscinaAgent(chatId, userMessage);
    return;
  }

  if (analyzed && !msg.fromMe && analyzed.nicho === 'IMPORTADOS' && (analyzed.category === 'Cliente' || analyzed.category === 'Casual')) {
    activeSessions.set(chatId, { department: 'IMPORTADOS', history: [] });
    console.log(`[Roteador 🔀] Lead ${chatId} encaminhado para IMPORTADOS.`);
    await handleImportadosAgent(chatId, userMessage);
    return;
  }
});

// ========== API ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/dashboard-stats', async (_req, res) => {
  try {
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    const nichos = ['DESIGN_DEV', 'IMPORTADOS', 'VESTUARIO', 'LOCACAO', 'OUTROS'];

    const volumeRows = await db.all(
      `SELECT nicho, COUNT(DISTINCT sender_id) AS total_leads
       FROM learning_data WHERE timestamp >= ? GROUP BY nicho`,
      [cutoff24h]
    );
    const volumeByNicho = nichos.reduce((a, n) => ((a[n] = 0), a), {});
    for (const r of volumeRows) volumeByNicho[normalizeLearningNicho(r.nicho)] = Number(r.total_leads || 0);

    const contactsRows = await db.all(
      `SELECT nicho, sender_id, COUNT(*) AS total_messages
       FROM learning_data WHERE timestamp >= ? GROUP BY nicho, sender_id ORDER BY nicho, total_messages DESC`,
      [cutoff24h]
    );
    const contactsByNicho = nichos.reduce((a, n) => ((a[n] = []), a), {});
    for (const r of contactsRows) {
      const n = normalizeLearningNicho(r.nicho);
      if (contactsByNicho[n].length >= 12) continue;
      contactsByNicho[n].push({ sender_id: String(r.sender_id || ''), total_messages: Number(r.total_messages || 0) });
    }

    const supplierRows = await db.all(
      `SELECT COALESCE(supplier_subtype, 'DROPSHIPPING_BR') AS supplier_subtype,
              COALESCE(SUM(price_calculated),0) AS total_price_calculated,
              COUNT(*) AS message_count
       FROM learning_data
       WHERE timestamp >= ? AND category = 'Fornecedor' AND price_calculated IS NOT NULL
       GROUP BY COALESCE(supplier_subtype, 'DROPSHIPPING_BR')`,
      [startOfDay]
    );
    const supplierPipeline = {
      DROPSHIPPING_BR: { total_price_calculated: 0, message_count: 0 },
      PARAGUAI_DOLLAR: { total_price_calculated: 0, message_count: 0 }
    };
    for (const r of supplierRows) {
      const s = normalizeSupplierSubtype(r.supplier_subtype) || 'DROPSHIPPING_BR';
      if (!supplierPipeline[s]) continue;
      supplierPipeline[s] = {
        total_price_calculated: Number(r.total_price_calculated || 0),
        message_count: Number(r.message_count || 0)
      };
    }

    const leadAlerts = await db.all(
      `WITH ranked AS (
         SELECT
           id,
           timestamp,
           sender_id,
           nicho,
           raw_content,
           processed_insight,
           priority,
           ROW_NUMBER() OVER (PARTITION BY sender_id ORDER BY timestamp DESC, id DESC) AS rn
         FROM learning_data
         WHERE timestamp >= ?
           AND category = 'Cliente'
           AND (
             nicho = 'LOCACAO' OR
             lower(raw_content) LIKE '%orçamento%' OR lower(raw_content) LIKE '%orcamento%' OR
             lower(raw_content) LIKE '%cotação%' OR lower(raw_content) LIKE '%cotacao%' OR
             lower(raw_content) LIKE '%valor%' OR lower(raw_content) LIKE '%preço%' OR lower(raw_content) LIKE '%preco%'
           )
       )
       SELECT id, timestamp, sender_id, nicho, raw_content, processed_insight, priority
       FROM ranked
       WHERE rn = 1
       ORDER BY timestamp DESC, id DESC
       LIMIT 5`,
      [cutoff24h]
    );

    const monthlyRevenue = await db.get(
      `SELECT COALESCE(SUM(revenue),0) AS monthly_revenue
       FROM learning_data
       WHERE timestamp >= ? AND deal_closed = 1 AND revenue IS NOT NULL`,
      [startOfMonth]
    );
    const lostLeads = await db.get(
      `SELECT COUNT(*) AS lost_leads
       FROM learning_data
       WHERE deal_closed = 0 AND archived = 1`
    );

    return res.json({
      ok: true,
      generated_at: now.toISOString(),
      window: '24h',
      volume_by_nicho: volumeByNicho,
      contacts_by_nicho: contactsByNicho,
      monthly_revenue: Number(monthlyRevenue?.monthly_revenue || 0),
      lost_leads_count: Number(lostLeads?.lost_leads || 0),
      supplier_pipeline_today: supplierPipeline,
      lead_alerts: leadAlerts.map((r) => ({
        id: Number(r.id),
        timestamp: r.timestamp,
        nicho: normalizeLearningNicho(r.nicho),
        sender_id: r.sender_id,
        raw_content: r.raw_content,
        insight: r.processed_insight,
        priority: Number(r.priority || 2)
      }))
    });
  } catch (err) {
    console.error('[API /api/dashboard-stats] Falha:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao gerar dashboard stats' });
  }
});

app.post('/api/leads/:id/close', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const revenue = Number(req.body?.revenue);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'ID inválido' });
    if (!Number.isFinite(revenue) || revenue < 0) return res.status(400).json({ ok: false, error: 'Revenue inválido' });

    const result = await db.run(
      `UPDATE learning_data SET deal_closed = 1, revenue = ?, archived = 0 WHERE id = ?`,
      [revenue, id]
    );
    if (!Number(result?.changes || 0)) return res.status(404).json({ ok: false, error: 'Lead não encontrado' });
    return res.json({ ok: true, id, deal_closed: 1, revenue, archived: 0 });
  } catch (err) {
    console.error('[API /api/leads/:id/close] Falha:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao fechar venda' });
  }
});

app.post('/api/leads/:id/archive', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'ID inválido' });
    const result = await db.run(`UPDATE learning_data SET deal_closed = 0, archived = 1 WHERE id = ?`, [id]);
    if (!Number(result?.changes || 0)) return res.status(404).json({ ok: false, error: 'Lead não encontrado' });
    return res.json({ ok: true, id, deal_closed: 0, archived: 1 });
  } catch (err) {
    console.error('[API /api/leads/:id/archive] Falha:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao arquivar lead' });
  }
});

app.get('/api/resolve-contact', async (req, res) => {
  try {
    const senderId = String(req.query?.sender_id || '').trim();
    if (!senderId) return res.status(400).json({ ok: false, error: 'sender_id é obrigatório' });

    if (senderId.endsWith('@c.us')) {
      const phone = senderId.replace('@c.us', '').replace(/\D/g, '');
      return res.json({ ok: true, sender_id: senderId, phone, resolved_id: senderId, wa_url: `https://web.whatsapp.com/send?phone=${phone}` });
    }
    if (senderId.endsWith('@lid')) {
      try {
        const resolved = await client.getContactLidAndPhone([senderId]);
        const first = Array.isArray(resolved) ? resolved[0] : null;
        const pn = String(first?.pn || '').trim();
        if (pn.endsWith('@c.us')) {
          const phone = pn.replace('@c.us', '').replace(/\D/g, '');
          return res.json({ ok: true, sender_id: senderId, phone, resolved_id: pn, wa_url: `https://web.whatsapp.com/send?phone=${phone}` });
        }
      } catch (err) {
        console.warn('[API /api/resolve-contact] Falha @lid:', err?.message || err);
      }
    }
    return res.status(404).json({ ok: false, sender_id: senderId, error: 'Não foi possível resolver o contato para número.' });
  } catch (err) {
    console.error('[API /api/resolve-contact] Erro interno:', err);
    return res.status(500).json({ ok: false, error: 'Falha ao resolver contato' });
  }
});

async function startServer() {
  await initDatabase();
  console.log(`[SQLite] Banco inicializado em ${DB_FILE}`);

  app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log('Iniciando WhatsApp Web...');
    client.initialize();
  });
}

startServer().catch((err) => {
  console.error('[Startup Error] Falha ao iniciar aplicação:', err);
  process.exit(1);
});

