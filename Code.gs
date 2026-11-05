const LIMITS_ = Object.freeze({fileBytes: 2 * 1024 * 1024 * 1024, dailyBytes: 20 * 1024 * 1024 * 1024, chunkBytes: 4 * 1024 * 1024, prefixBytes: 65536, ticketMs: 24 * 60 * 60 * 1000, sessions: 64});
const MIME_TYPES_ = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif', 'image/tiff', 'image/x-adobe-dng', 'video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];
const FILE_FIELDS_ = 'id,name,mimeType,size,parents,appProperties,trashed';
const PAGE_ORIGIN_ = 'https://lok274.github.io';
const MAX_RPC_CHARS_ = 6 * 1024 * 1024;
const UPLOAD_DEADLINE_ = Date.parse('2026-11-09T23:59:00+08:00');

function doGet() {
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><p>收相盒後端已就緒。<a href="https://lok274.github.io/photo-collector/" target="_top">開啟收相頁</a></p>');
}

function doPost(event) {
  const reply = {id: '', method: '', ok: false};
  try {
    const payload = event && event.parameter && event.parameter.payload;
    if (typeof payload !== 'string' || payload.length > MAX_RPC_CHARS_) throw new Error('上傳要求無效或太大。');
    const request = JSON.parse(payload);
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        typeof request.id !== 'string' || !/^[a-f0-9]{32}$/.test(request.id)) throw new Error('上傳要求無效。');
    reply.id = request.id;
    const methods = {prepareUpload: [prepareUpload_, 3], uploadChunk: [uploadChunk_, 4], getUploadStatus: [getUploadStatus_, 2]};
    if (!Object.prototype.hasOwnProperty.call(methods, request.method) || !Array.isArray(request.args) ||
        request.args.length !== methods[request.method][1]) throw new Error('上傳要求無效。');
    reply.method = request.method;
    reply.result = methods[request.method][0].apply(null, request.args);
    reply.ok = true;
  } catch (error) {
    reply.error = error instanceof SyntaxError ? '上傳要求無效。' : String(error.message || '服務暫時未能回應，請保留此頁並重試。').slice(0, 400);
  }
  const json = JSON.stringify(reply).replace(/</g, '\\u003c');
  return HtmlService.createHtmlOutput('<!doctype html><meta charset="utf-8"><script>window.top.postMessage(' + json + ', ' + JSON.stringify(PAGE_ORIGIN_) + ');</script>')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function prepareUpload_(code, metadata, prefixBase64) {
  const config = authenticate_(code);
  const media = metadata_(metadata);
  const prefix = decode_(prefixBase64, Math.min(media.size, LIMITS_.prefixBytes));
  if (!equal_(digest_(prefix), media.prefixSha256) || !typeMatches_(mediaType_(prefix), media.mime)) {
    throw new Error('檔案標頭或格式驗證失敗，請選取原檔。');
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('現在有人正在準備上傳，請稍後重試。');
  try {
    const properties = PropertiesService.getScriptProperties();
    const key = 'UPLOAD_' + media.uploadKey;
    let record = readRecord_(properties.getProperty(key));
    if (record) {
      verifyTicket_(record.ticket, config);
      if (JSON.stringify(metadata_(record.ticket)) !== JSON.stringify(media)) throw new Error('上傳編號與檔案不符，請聯絡收相人。');
    } else {
      const receipt = recoverReceipt_(media, config);
      if (receipt) return receipt;
      cleanupSessions_(properties);
      const fileId = Drive.Files.generateIds({count: 1, space: 'drive', type: 'files'}).ids[0];
      if (typeof fileId !== 'string' || !/^[\w-]{10,200}$/.test(fileId)) throw new Error('暫時無法準備上傳，請稍後再試。');
      const ticket = Object.assign({fileId: fileId}, media, {expiresAt: Math.min(Date.now() + LIMITS_.ticketMs, UPLOAD_DEADLINE_)});
      ticket.signature = sign_(ticket, config);
      record = {ticket: ticket, session: ''};
      const updates = {DAILY_USAGE: JSON.stringify(reserveBytes_(media.size))};
      updates[key] = JSON.stringify(record);
      properties.setProperties(updates);
    }
    if (!record.session && !completed_(record.ticket, config)) {
      const ticket = record.ticket;
      const response = driveFetch_('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=' + encodeURIComponent(FILE_FIELDS_), {
        method: 'post', contentType: 'application/json',
        headers: {'X-Upload-Content-Type': ticket.mime, 'X-Upload-Content-Length': String(ticket.size)},
        payload: JSON.stringify({id: ticket.fileId, name: ticket.name, mimeType: ticket.mime, parents: [config.folderId], appProperties: appProperties_(ticket)})
      });
      if (response.getResponseCode() !== 200) throw new Error('未能確認上傳準備結果。請保留此頁並重試，程式會沿用原編號。');
      const session = header_(response, 'Location');
      if (!validSession_(session)) throw new Error('未能取得安全上傳連線，請保留此頁並重試。');
      record.session = session;
      properties.setProperty(key, JSON.stringify(record));
    }
    return record.ticket;
  } finally {
    lock.releaseLock();
  }
}

function getUploadStatus_(code, ticket) {
  const config = authenticate_(code);
  verifyTicket_(ticket, config);
  if (completed_(ticket, config)) return saved_(ticket);
  const record = sessionRecord_(ticket);
  const response = driveFetch_(record.session, {method: 'put', contentType: ticket.mime, headers: {'Content-Range': 'bytes */' + ticket.size}, payload: ''});
  return uploadResponse_(response, ticket, config);
}

function uploadChunk_(code, ticket, offset, base64) {
  const config = authenticate_(code);
  verifyTicket_(ticket, config);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= ticket.size) throw new Error('上傳位置無效，請按重試核對進度。');
  if (typeof base64 !== 'string' || base64.length > 4 * Math.ceil(LIMITS_.chunkBytes / 3)) throw new Error('分段資料太大或無效。');
  const bytes = decode_(base64);
  if (!bytes.length || bytes.length > LIMITS_.chunkBytes || offset + bytes.length > ticket.size ||
      (offset + bytes.length !== ticket.size && bytes.length % 262144 !== 0)) throw new Error('分段大小或位置無效，請按重試。');
  if (offset === 0 && !equal_(digest_(bytes.slice(0, Math.min(ticket.size, LIMITS_.prefixBytes))), ticket.prefixSha256)) throw new Error('檔案標頭與上傳憑證不符，請選取原檔。');
  if (completed_(ticket, config)) return saved_(ticket);
  const record = sessionRecord_(ticket);
  const response = driveFetch_(record.session, {method: 'put', contentType: ticket.mime,
    headers: {'Content-Range': 'bytes ' + offset + '-' + (offset + bytes.length - 1) + '/' + ticket.size}, payload: bytes});
  return uploadResponse_(response, ticket, config);
}

function uploadResponse_(response, ticket, config) {
  const status = response.getResponseCode();
  if (status === 200 || status === 201) {
    if (completed_(ticket, config)) return saved_(ticket);
    throw new Error('伺服器未有確認檔案完整儲存。請保留此頁並重試。');
  }
  if (status === 308) {
    const range = header_(response, 'Range');
    if (!range) return {status: 'uploading', offset: 0};
    const match = /^bytes=0-(\d+)$/.exec(range);
    const offset = match ? Number(match[1]) + 1 : NaN;
    if (!Number.isSafeInteger(offset) || offset < 1 || offset >= ticket.size) throw new Error('未能核對伺服器進度，請保留此頁並重試。');
    return {status: 'uploading', offset: offset};
  }
  if (completed_(ticket, config)) return saved_(ticket);
  if (status === 404 || status === 410) throw new Error('上傳連線已過期或遺失。請聯絡收相人核對，核對後才重新選取，避免重複交檔。');
  throw new Error('上傳未獲確認。請保留此頁，按重試核對及繼續上傳。');
}

function driveFetch_(url, options) {
  if (Date.now() >= UPLOAD_DEADLINE_) throw new Error('收相已截止，不能再上傳。已收到的檔案會保留。');
  options.headers = Object.assign({}, options.headers, {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()});
  options.muteHttpExceptions = true;
  options.followRedirects = false;
  try { return UrlFetchApp.fetch(url, options); }
  catch (error) { throw new Error('連線中斷，未能確認進度。請保留此頁並按重試。'); }
}

function header_(response, name) {
  const headers = response.getAllHeaders();
  const key = Object.keys(headers).find(function (key) { return key.toLowerCase() === name.toLowerCase(); });
  return key && typeof headers[key] === 'string' ? headers[key] : '';
}

function validSession_(value) {
  return typeof value === 'string' && value.length <= 4096 && /^https:\/\/www\.googleapis\.com\/upload\/drive\/v3\/files\?(?=[^#\s]*\bupload_id=)[A-Za-z0-9%_.~!$&'()*+,;=:@/?-]+$/.test(value);
}

function sessionRecord_(ticket) {
  const record = readRecord_(PropertiesService.getScriptProperties().getProperty('UPLOAD_' + ticket.uploadKey));
  if (!record || record.ticket.signature !== ticket.signature || !validSession_(record.session)) throw new Error('上傳連線已過期或遺失。請聯絡收相人核對，避免重複交檔。');
  return record;
}

function readRecord_(value) {
  if (!value) return null;
  try {
    const record = JSON.parse(value);
    if (!record || !record.ticket || typeof record.session !== 'string') throw new Error();
    return record;
  } catch (error) { throw new Error('上傳進度紀錄有問題，請聯絡收相人。'); }
}

function cleanupSessions_(properties) {
  const all = properties.getProperties();
  let active = 0;
  Object.keys(all).filter(function (key) { return /^UPLOAD_[a-f0-9]{32}$/.test(key); }).forEach(function (key) {
    const record = readRecord_(all[key]);
    if (record.ticket.expiresAt <= Date.now()) properties.deleteProperty(key);
    else active++;
  });
  if (active >= LIMITS_.sessions) throw new Error('暫時有太多未完成上傳，請稍後再試或聯絡收相人。');
}

function completed_(ticket, config) {
  let file;
  try { file = Drive.Files.get(ticket.fileId, {fields: FILE_FIELDS_}); }
  catch (error) { return false; }
  if (!file || file.id !== ticket.fileId || file.trashed || file.name !== ticket.name || file.mimeType !== ticket.mime ||
      Number(file.size) !== ticket.size || !file.parents || file.parents.length !== 1 || file.parents[0] !== config.folderId ||
      !file.appProperties || file.appProperties.uploadKey !== ticket.uploadKey || file.appProperties.prefixSha256 !== ticket.prefixSha256 || file.appProperties.expiresAt !== String(ticket.expiresAt)) {
    throw new Error('此上傳編號與已儲存檔案不符，請聯絡收相人核對。');
  }
  try {
    const broadPermissions = function () {
      const result = Drive.Permissions.list(ticket.fileId, {fields: 'permissions(id,type),nextPageToken', pageSize: 100});
      if (!result || !Array.isArray(result.permissions) || result.nextPageToken ||
          result.permissions.some(function (permission) { return !permission || typeof permission.id !== 'string' || !['user', 'group', 'domain', 'anyone'].includes(permission.type); })) throw new Error();
      return result.permissions.filter(function (permission) { return permission.type === 'domain' || permission.type === 'anyone'; });
    };
    const broad = broadPermissions();
    broad.forEach(function (permission) { Drive.Permissions.remove(ticket.fileId, permission.id); });
    if (broad.length && broadPermissions().length) throw new Error();
  } catch (error) { throw new Error('暫時未能確認檔案分享權限已受限制。請保留此頁並按重試；如持續失敗，請聯絡收相人。'); }
  return true;
}

function saved_(ticket) {
  PropertiesService.getScriptProperties().deleteProperty('UPLOAD_' + ticket.uploadKey);
  return {status: 'saved', offset: ticket.size};
}

function appProperties_(ticket) {
  return {uploadKey: ticket.uploadKey, prefixSha256: ticket.prefixSha256, expiresAt: String(ticket.expiresAt)};
}

function recoverReceipt_(media, config) {
  let result;
  try {
    result = Drive.Files.list({q: "'" + config.folderId + "' in parents and trashed = false and appProperties has { key='uploadKey' and value='" + media.uploadKey + "' }", fields: 'files(' + FILE_FIELDS_ + '),nextPageToken', pageSize: 2});
  } catch (error) { throw new Error('暫時未能核對已有上傳，請保留此頁並重試。'); }
  if (!result.files || !result.files.length) return null;
  if (result.files.length !== 1 || result.nextPageToken) throw new Error('上傳編號有重複紀錄，請聯絡收相人核對。');
  const file = result.files[0];
  const ticket = Object.assign({fileId: file.id}, media, {expiresAt: Number(file.appProperties && file.appProperties.expiresAt)});
  ticket.signature = sign_(ticket, config);
  verifyTicket_(ticket, config);
  if (!completed_(ticket, config)) throw new Error('暫時未能核對已有上傳，請保留此頁並重試。');
  return ticket;
}

function setup_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const properties = PropertiesService.getScriptProperties();
    let config;
    if (properties.getProperty('COLLECTOR_CONFIG')) config = config_();
    else {
      const folder = Drive.Files.create({name: '收相盒 · 手機相片', mimeType: 'application/vnd.google-apps.folder'}, null, {fields: 'id'});
      config = {folderId: folder.id, uploadCode: Utilities.getUuid().replace(/-/g, ''), hmacSecret: Utilities.getUuid() + Utilities.getUuid()};
      properties.setProperty('COLLECTOR_CONFIG', JSON.stringify(config));
    }
    console.log('私人相片資料夾 https://drive.google.com/drive/folders/' + config.folderId);
    console.log('上傳碼 ' + config.uploadCode);
  } finally { lock.releaseLock(); }
}

function config_() {
  let config;
  try { config = JSON.parse(PropertiesService.getScriptProperties().getProperty('COLLECTOR_CONFIG') || 'null'); }
  catch (error) { throw new Error('收相盒設定有問題，請聯絡收相人。'); }
  if (!config || typeof config.folderId !== 'string' || typeof config.uploadCode !== 'string' || !config.folderId || config.uploadCode.length < 24 ||
      typeof config.hmacSecret !== 'string' || config.hmacSecret.length < 64) throw new Error('收相盒尚未設定完成，請聯絡收相人。');
  return config;
}

function authenticate_(code) {
  if (Date.now() >= UPLOAD_DEADLINE_) throw new Error('收相已於香港時間 2026-11-09 23:59 截止，不能再上傳。已收到的檔案會保留。');
  const config = config_();
  if (typeof code !== 'string' || code.length > 128 || !equal_(code.trim(), config.uploadCode)) throw new Error('上傳碼不正確，請向收相人確認。');
  return config;
}

function metadata_(value) {
  if (!value || typeof value !== 'object' || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f\x7f/\\]/.test(value.name)) throw new Error('檔名無效，請改用 200 字以內的檔名。');
  if (MIME_TYPES_.indexOf(value.mime) < 0) throw new Error('只接受支援的相片或影片格式。');
  if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > LIMITS_.fileBytes) throw new Error('每個檔案必須大於 0 並且不超過 2 GB（2 GiB）。');
  if (typeof value.uploadKey !== 'string' || !/^[a-f0-9]{32}$/.test(value.uploadKey) || typeof value.prefixSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.prefixSha256)) throw new Error('檔案驗證資料無效，請重新選取。');
  return {name: value.name, mime: value.mime, size: value.size, uploadKey: value.uploadKey, prefixSha256: value.prefixSha256};
}

function ticketPayload_(ticket, config) {
  return JSON.stringify([config.folderId, ticket.fileId, ticket.uploadKey, ticket.name, ticket.mime, ticket.size, ticket.prefixSha256, ticket.expiresAt]);
}

function sign_(ticket, config) {
  return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(ticketPayload_(ticket, config), config.hmacSecret));
}

function verifyTicket_(ticket, config) {
  metadata_(ticket);
  if (typeof ticket.fileId !== 'string' || !/^[\w-]{10,200}$/.test(ticket.fileId) || !Number.isSafeInteger(ticket.expiresAt) ||
      ticket.expiresAt > UPLOAD_DEADLINE_ || typeof ticket.signature !== 'string' || !equal_(ticket.signature, sign_(ticket, config))) throw new Error('上傳憑證無效，請聯絡收相人。');
  if (ticket.expiresAt <= Date.now()) throw new Error('這個檔案的上傳憑證已過期。請聯絡收相人核對是否已收妥，核對後才重新選取，避免重複交檔。');
}

function equal_(left, right) {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return difference === 0;
}

function decode_(base64, expected) {
  if (typeof base64 !== 'string' || (expected !== undefined && base64.length !== 4 * Math.ceil(expected / 3)) || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('檔案傳送資料不完整，請重試。');
  let bytes;
  try { bytes = Utilities.base64Decode(base64); }
  catch (error) { throw new Error('檔案傳送資料無效，請重試。'); }
  if ((expected !== undefined && bytes.length !== expected) || Utilities.base64Encode(bytes) !== base64) throw new Error('檔案傳送資料大小或編碼不符，請重試。');
  return bytes;
}

function digest_(bytes) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes).map(function (byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function typeMatches_(detected, mime) {
  if (!detected) return false;
  if (detected === mime) return true;
  return (['image/heic', 'image/heif'].indexOf(detected) >= 0 && ['image/heic', 'image/heif'].indexOf(mime) >= 0) ||
    (detected === 'image/tiff' && mime === 'image/x-adobe-dng');
}

function mediaType_(bytes) {
  const byte = function (index) { return bytes[index] & 255; };
  const text = function (start, length) { return bytes.slice(start, start + length).map(function (value) { return String.fromCharCode(value & 255); }).join(''); };
  if (bytes.length >= 3 && byte(0) === 255 && byte(1) === 216 && byte(2) === 255) return 'image/jpeg';
  if (text(0, 8) === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (text(0, 6) === 'GIF87a' || text(0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') return 'image/webp';
  if (text(0, 4) === 'II\x2a\x00' || text(0, 4) === 'MM\x00\x2a') return 'image/tiff';
  if (bytes.length >= 8 && byte(0) === 26 && byte(1) === 69 && byte(2) === 223 && byte(3) === 163 && /\x42\x82[\x81-\x88]webm/.test(text(0, bytes.length))) return 'video/webm';
  if (bytes.length >= 8 && ['moov', 'mdat', 'wide'].indexOf(text(4, 4)) >= 0) {
    const atomSize = byte(0) * 16777216 + byte(1) * 65536 + byte(2) * 256 + byte(3);
    if (atomSize === 0 || atomSize >= 8) return 'video/quicktime';
  }
  if (bytes.length < 16 || text(4, 4) !== 'ftyp') return null;
  const boxSize = byte(0) * 16777216 + byte(1) * 65536 + byte(2) * 256 + byte(3);
  if (boxSize < 16 || boxSize > bytes.length || boxSize > LIMITS_.prefixBytes || boxSize % 4 !== 0) return null;
  const brands = [text(8, 4)];
  for (let offset = 16; offset < boxSize; offset += 4) brands.push(text(offset, 4));
  if (brands.some(function (brand) { return ['avif', 'avis'].indexOf(brand) >= 0; })) return 'image/avif';
  if (brands.some(function (brand) { return ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs'].indexOf(brand) >= 0; })) return 'image/heic';
  if (brands.some(function (brand) { return ['mif1', 'msf1'].indexOf(brand) >= 0; })) return 'image/heif';
  if (brands.indexOf('qt  ') >= 0) return 'video/quicktime';
  if (brands.some(function (brand) { return /^3g[pge][0-9a-z]$/.test(brand); })) return 'video/3gpp';
  if (brands.some(function (brand) { return ['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'avc1', 'hvc1', 'hev1', 'M4V ', 'MSNV', 'dash'].indexOf(brand) >= 0; })) return 'video/mp4';
  return null;
}

function reserveBytes_(size) {
  const properties = PropertiesService.getScriptProperties();
  const day = Utilities.formatDate(new Date(), 'Asia/Hong_Kong', 'yyyy-MM-dd');
  let quota;
  try { quota = JSON.parse(properties.getProperty('DAILY_USAGE') || 'null'); }
  catch (error) { throw new Error('今日用量紀錄有問題，請聯絡收相人。'); }
  if (quota && (typeof quota.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(quota.day) || !Number.isSafeInteger(quota.bytes) || quota.bytes < 0)) throw new Error('今日用量紀錄有問題，請聯絡收相人。');
  if (!quota || quota.day !== day) quota = {day: day, bytes: 0};
  if (quota.bytes + size > LIMITS_.dailyBytes) throw new Error('今日收檔容量已用完，請明天再交，或聯絡收相人。');
  // shortcut: uncertain or abandoned uploads keep their reservation, reset at Hong Kong midnight.
  quota.bytes += size;
  return quota;
}
