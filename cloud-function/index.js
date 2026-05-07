/**
 * Авито Трекер — Yandex Cloud Function
 * Версия: 1.0
 *
 * Деплой: Yandex Cloud Functions → Node.js 18
 * Переменные окружения:
 *   YDB_ENDPOINT  — например: grpcs://ydb.serverless.yandexcloud.net:2135
 *   YDB_DATABASE  — например: /ru-central1/xxxxx/xxxxxxxx
 *   TABLE_NAME    — например: avito_tracker (по умолчанию)
 *
 * Таблица YDB создаётся автоматически при первом запросе.
 */

const { Driver, getCredentialsFromEnv, Column, TableDescription, Types } = require('ydb-sdk');

const YDB_ENDPOINT = process.env.YDB_ENDPOINT;
const YDB_DATABASE = process.env.YDB_DATABASE;
const TABLE_NAME = process.env.TABLE_NAME || 'avito_tracker';

let driver = null;

// ── Инициализация драйвера YDB ──
async function getDriver() {
  if (driver) return driver;
  const authService = getCredentialsFromEnv();
  driver = new Driver({ endpoint: YDB_ENDPOINT, database: YDB_DATABASE, authService });
  const timeout = 10000;
  if (!await driver.ready(timeout)) throw new Error('YDB: драйвер не готов');
  return driver;
}

// ── Создать таблицу если не существует ──
async function ensureTable(session) {
  await session.createTable(
    TABLE_NAME,
    new TableDescription()
      .withColumn(new Column('key', Types.optional(Types.UTF8)))
      .withColumn(new Column('value', Types.optional(Types.UTF8)))
      .withColumn(new Column('updated_at', Types.optional(Types.UTF8)))
      .withPrimaryKey('key'),
    { existOk: true }
  );
}

// ── Получить данные ──
async function getData(session, key) {
  const query = `
    DECLARE $key AS Utf8;
    SELECT value FROM \`${TABLE_NAME}\` WHERE key = $key;
  `;
  const { resultSets } = await session.executeQuery(query, { '$key': { type: Types.UTF8, value: { textValue: key } } });
  if (!resultSets[0]?.rows?.length) return null;
  const val = resultSets[0].rows[0].items[0]?.textValue;
  return val ? JSON.parse(val) : null;
}

// ── Сохранить данные ──
async function setData(session, key, data) {
  const query = `
    DECLARE $key AS Utf8;
    DECLARE $value AS Utf8;
    DECLARE $updated_at AS Utf8;
    UPSERT INTO \`${TABLE_NAME}\` (key, value, updated_at)
    VALUES ($key, $value, $updated_at);
  `;
  await session.executeQuery(query, {
    '$key': { type: Types.UTF8, value: { textValue: key } },
    '$value': { type: Types.UTF8, value: { textValue: JSON.stringify(data) } },
    '$updated_at': { type: Types.UTF8, value: { textValue: new Date().toISOString() } },
  });
}

// ── CORS-заголовки ──
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function ok(body) {
  return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function err(status, message) {
  return { statusCode: status, headers: CORS_HEADERS, body: JSON.stringify({ error: message }) };
}

// ── Точка входа Cloud Function ──
module.exports.handler = async (event) => {
  // Preflight CORS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS_HEADERS, body: '' };
  }

  const action = event.queryStringParameters?.action || 'get';
  const DATA_KEY = 'tracker_state';

  // Ping — проверка работоспособности
  if (action === 'ping') {
    return ok({ status: 'ok', timestamp: new Date().toISOString() });
  }

  try {
    const drv = await getDriver();
    let result;

    await drv.tableClient.withSession(async (session) => {
      await ensureTable(session);

      if (action === 'get') {
        // ── GET: вернуть текущее состояние ──
        const data = await getData(session, DATA_KEY);
        result = ok(data || { regions: [], currentRegion: null });

      } else if (action === 'set' && event.httpMethod === 'POST') {
        // ── SET: сохранить новое состояние ──
        let body;
        try {
          body = JSON.parse(event.body || '{}');
        } catch(e) {
          result = err(400, 'Неверный JSON');
          return;
        }
        // Базовая валидация
        if (!body.regions || !Array.isArray(body.regions)) {
          result = err(400, 'Неверный формат данных');
          return;
        }
        await setData(session, DATA_KEY, body);
        result = ok({ status: 'saved', timestamp: new Date().toISOString() });

      } else {
        result = err(400, 'Неизвестный action: ' + action);
      }
    });

    return result;

  } catch (e) {
    console.error('Cloud Function error:', e);
    return err(500, 'Внутренняя ошибка: ' + e.message);
  }
};
