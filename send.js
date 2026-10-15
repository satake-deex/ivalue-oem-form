// インクレイブ様 ivalue OEM先のフォーム打診（渡邉さんのタイムワールド様版 send.js を流用）
//   node send.js --limit 20 [--dry] [--seg printing] [--conc 3] [--only domain] [--targets file.json]
// 送信者は sender.json、文面は templates.json（業種別 A/B）。has_web: true の会社から順に送る。
// ブラウザは PC の Google Chrome（channel: 'chrome'）。別の場所なら環境変数 CHROME_PATH で指定。
// 台帳 results.jsonl に1社1行。sent / sent_unknown / skip_* / fail_* の domain は二度と触らない（--retry-fail で fail_* だけ再試行）
import { chromium } from 'playwright-core';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ARGS = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
  return a;
}, []));
const DRY = !!ARGS.dry;
const LIMIT = +(ARGS.limit || 10);
const CONC = +(ARGS.conc || 3);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(DIR, 'results.jsonl');
const SHOTS = path.join(DIR, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const EXE = process.env.CHROME_PATH;

const T = JSON.parse(fs.readFileSync(path.join(DIR, 'templates.json'), 'utf8'));
const S = JSON.parse(fs.readFileSync(path.join(DIR, 'sender.json'), 'utf8'));
const hira = k => k.replace(/[\u30a1-\u30f6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const [tel1, tel2, tel3] = S.tel.split('-');
const [zip1, zip2] = S.zip.split('-');
const ME = {
  company: S.company, dept: S.department, title: S.position,
  sei: S.last_name, mei: S.first_name, name: `${S.last_name} ${S.first_name}`,
  seiKana: S.last_name_kana, meiKana: S.first_name_kana, kana: `${S.last_name_kana} ${S.first_name_kana}`,
  seiHira: hira(S.last_name_kana), meiHira: hira(S.first_name_kana), hira: hira(`${S.last_name_kana} ${S.first_name_kana}`),
  email: S.email, tel: S.tel, tel1, tel2, tel3,
  zip: S.zip, zip1, zip2, pref: S.pref, city: S.city + S.address_line.replace(/[0-9０-９].*$/, ''), addr1: S.address_line.replace(/^[^0-9０-９]*/, '').replace('丁目', '-'), bldg: S.building,
  address: S.address, url: S.website, industry: 'コンサルティング',
};
// A/B はドメインから固定で振り分ける（再実行しても同じ社には同じ文面）
const variant = t => [...t.domain].reduce((h, c) => h + c.charCodeAt(0), 0) % 2 ? 'B' : 'A';
function message(t) {
  const c = T.common, seg = T.segments[t.seg];
  return [c.intro, seg[variant(t)].why, c.product, c.offer, c.cta, c.closing].join('\n\n')
    .replaceAll('{company}', t.company).replaceAll('{sender_company}', T.sender.sender_company).replaceAll('{sender_name}', T.sender.sender_name);
}

// ---- 台帳 ----
const done = new Map();
if (fs.existsSync(LEDGER)) for (const l of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
  if (!l.trim()) continue; const r = JSON.parse(l); done.set(r.domain, r);
}
const sentForms = new Set([...done.values()].filter(r => /^sent/.test(r.status) && r.formUrl).map(r => r.formUrl.split('?')[0]));
function record(r) { fs.appendFileSync(LEDGER, JSON.stringify({ ts: new Date().toISOString(), dry: DRY || undefined, ...r }) + '\n'); }

const targets = JSON.parse(fs.readFileSync(path.resolve(DIR, ARGS.targets || 'targets.json'), 'utf8'))
  .map(t => ({ ...t, seg: t.segment, hp: t.url }))
  .sort((a, b) => (b.has_web === true) - (a.has_web === true))
  .filter(t => {
  if (ARGS.only) return t.domain === ARGS.only;
  if (ARGS.seg && t.seg !== ARGS.seg) return false;
  const p = done.get(t.domain);
  if (!p || p.dry) return true;
  if (ARGS['retry-fail'] && /^fail_/.test(p.status)) return true;
  return false;
}).slice(0, LIMIT);

const CONTACT_RE = /お問い?合わせ|お問合せ|問合せ|問い合わせ|ご相談|contact|inquiry|toiawase|otoiawase|enquiry/i;
const NG_SALES_RE = /(営業|セールス|勧誘|売り込み)[^。]{0,25}(お断り|ご遠慮|禁止|控えて|受け付けて(い|お)りません|対応(いた)?しかね|返信(いた)?しません)/;
const BAD_LINK_RE = /採用|求人|recruit|entry|資料請求|カタログ|見積|予約|reserve|faq|よくある|会員|login|サポート窓口|修理|privacy|個人情報/i;

async function findContactUrl(page, hp) {
  const links = await page.$$eval('a[href]', as => as.map(a => ({ href: a.href, text: (a.innerText || a.title || '').trim().slice(0, 40) })));
  const host = new URL(page.url()).hostname.replace(/^www\./, '');
  const cand = links.filter(l => /^https?:/.test(l.href) && (/(お問い?合わせ|お問合せ|問合せ|問い合わせ|contact|inquiry)/i.test(l.text) || /contact|inquiry|toiawase|otoiawase|form/i.test(l.href)))
    .filter(l => !BAD_LINK_RE.test(l.text) && !/recruit|entry|catalog|mitsumori|estimate|reserve/i.test(l.href))
    .map(l => ({ ...l, score: (new URL(l.href).hostname.replace(/^www\./, '') === host ? 2 : 0) + (/お問い?合わせ|お問合せ|問合せ|contact/i.test(l.text) ? 2 : 0) + (/contact|inquiry|toiawase/i.test(l.href) ? 1 : 0) }))
    .sort((a, b) => b.score - a.score);
  if (cand.length) return cand[0].href.split('#')[0];
  return null;
}

async function pageHasForm(page) {
  return await page.evaluate(() => [...document.querySelectorAll('form')].some(f => f.querySelector('textarea') && f.offsetParent !== null) || [...document.querySelectorAll('textarea')].some(t => t.offsetParent !== null));
}

async function captchaKind(page) {
  return await page.evaluate(() => {
    const h = document.documentElement.innerHTML;
    if (document.querySelector('.cf-turnstile,[name="cf-turnstile-response"]') || /challenges\.cloudflare\.com\/turnstile/.test(h)) return 'turnstile';
    if (document.querySelector('.h-captcha') || /hcaptcha\.com/.test(h)) return 'hcaptcha';
    const v2 = [...document.querySelectorAll('.g-recaptcha[data-sitekey]')].filter(e => e.getAttribute('data-size') !== 'invisible');
    if (v2.length) return 'recaptcha_v2';
    if ([...document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"]')].some(f => !/size=invisible/.test(f.src) && f.offsetHeight > 30)) return 'recaptcha_v2';
    if (/captcha/i.test([...document.querySelectorAll('form img')].map(i => i.src + i.alt).join(' ')) || document.querySelector('input[name*="captcha" i]:not([type=hidden])')) return 'image_captcha';
    return null;
  });
}

// ページ内でフォームを埋める。戻り値: {ok, reason, filled}
async function fillForm(page, me, msg, subject) {
  return await page.evaluate(([me, msg, subject]) => {
    const vis = e => { if (!e || e.offsetParent === null) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || +cs.opacity === 0) return false; const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && r.left > -500 && r.top > -500; };
    const forms = [...document.querySelectorAll('form')].filter(f => f.querySelector('textarea') && vis(f));
    const form = forms.sort((a, b) => b.querySelectorAll('input,textarea,select').length - a.querySelectorAll('input,textarea,select').length)[0] || document.body;
    const labelOf = el => {
      const parts = [];
      if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) parts.push(l.innerText); }
      const wrap = el.closest('label'); if (wrap) parts.push(wrap.innerText);
      const tr = el.closest('tr'); if (tr) { const th = tr.querySelector('th'); if (th) parts.push(th.innerText); }
      const dd = el.closest('dd'); if (dd) { let p = dd.previousElementSibling; while (p && p.tagName !== 'DT') p = p.previousElementSibling; if (p) parts.push(p.innerText); }
      if (!parts.join('').trim()) {
        // 近い順に、入力欄を1つだけ含む親の見出しを探す
        let n = el.parentElement;
        for (let i = 0; i < 4 && n; i++, n = n.parentElement) {
          const inputs = n.querySelectorAll('input:not([type=hidden]),textarea,select');
          const t = (n.innerText || '').trim();
          if (t && inputs.length <= 3) { const th = n.querySelector('th, dt, .label, .title, label, span, p'); parts.push((th ? th.innerText : t).slice(0, 60)); break; }
        }
      }
      parts.push(el.name || '', el.placeholder || '', el.getAttribute('aria-label') || '', el.id || '');
      return parts.join(' ').replace(/\s+/g, ' ').slice(0, 200);
    };
    const set = (el, v) => {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true }));
    };
    const filled = [];
    const special = [];
    const textEls = [...form.querySelectorAll('input:not([type]),input[type=text],input[type=email],input[type=tel],input[type=url],input[type=number]')].filter(vis);
    // 同じ行に複数入力がある（姓・名／電話3分割／郵便2分割）ものを検出するため、行ごとにまとめる
    const usedRows = new Map();
    for (const el of textEls) {
      const L = labelOf(el); const nm = (el.name + ' ' + el.id + ' ' + el.placeholder).toLowerCase();
      const row = el.closest('tr, dl, li, .form-group, .row, p, div');
      const sibs = row ? [...row.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox])')].filter(vis) : [el];
      const pos = sibs.indexOf(el);
      let v = null;
      if (el.type === 'email') v = me.email;
      else if (/確認|再入力|confirm|again|_mcon|re_?mail|mail2|email2/i.test(L) && /メール|mail/i.test(L)) v = me.email;
      else if (/メール|e-?mail|mail/i.test(L) && !/送信|配信/.test(L)) v = me.email;
      else if (/フリガナ|ふりがな|カナ|かな|kana|furigana|ruby/i.test(L)) {
        const hira = /ふりがな|ひらがな|かな/.test(L) && !/カナ|フリガナ/.test(L);
        if (sibs.length >= 2 && pos >= 0) v = pos === 0 ? (hira ? me.seiHira : me.seiKana) : (hira ? me.meiHira : me.meiKana);
        else if (/(セイ|姓|last|sei)/i.test(nm + L) && !/(メイ|first|mei)/i.test(nm)) v = hira ? me.seiHira : me.seiKana;
        else if (/(メイ|first|mei)/i.test(nm)) v = hira ? me.meiHira : me.meiKana;
        else v = hira ? me.hira : me.kana;
      }
      else if (/郵便|〒|zip|postal|post_?code/i.test(L)) { v = sibs.length >= 2 && pos >= 0 ? (pos === 0 ? me.zip1 : me.zip2) : me.zip; }
      else if (/電話|tel|phone|携帯/i.test(L) && !/fax/i.test(nm)) {
        const noHyphen = /半角数字|ハイフン(なし|不要|無し)|ハイフンを?(入れず|除いて)/.test(L) || /^0\d{9,10}$/.test((el.placeholder || '').trim()) || (el.maxLength > 0 && el.maxLength <= 11) || el.type === 'number';
        v = sibs.length >= 3 && pos >= 0 && pos < 3 ? [me.tel1, me.tel2, me.tel3][pos] : (noHyphen ? me.tel.replace(/-/g, '') : me.tel); }
      else if (/fax/i.test(L)) v = '';
      else if (/会社|法人|御社|貴社|企業|団体|組織|屋号|勤務先|company|corp|organi[sz]ation/i.test(L) && !/url|ホームページ|部署|役職/i.test(L)) v = me.company;
      else if (/部署|所属|department|division|section/i.test(L)) v = me.dept;
      else if (/役職|title|position/i.test(L) && !/件名|タイトル|subject/i.test(L)) v = me.title;
      else if (/件名|タイトル|subject|用件/i.test(L)) v = subject;
      else if (/url|ホームページ|ウェブサイト|website|hp/i.test(L)) v = (el.required || /必須|※|\*/.test(L.replace(el.name,''))) ? me.url : '';
      else if (/都道府県/.test(L)) v = me.pref;
      else if (/市区町村|市町村/.test(L)) v = me.city;
      else if (/番地/.test(L)) v = me.addr1;
      else if (/建物|ビル/.test(L)) v = me.bldg;
      else if (/住所|所在地|address/i.test(L)) v = me.address;
      else if (/業種|業界|industry/i.test(L)) v = me.industry;
      else if (/\[(first|mei)\]|first_?name/i.test(el.name)) v = me.mei;
      else if (/\[(last|sei)\]|last_?name/i.test(el.name)) v = me.sei;
      else if (/名前|氏名|担当者|ご担当|name|sei|mei/i.test(L)) {
        if (sibs.length >= 2 && pos >= 0 && !/会社/.test(L)) v = pos === 0 ? me.sei : me.mei;
        else if (/(姓|last|sei)\b/i.test(nm) && !/first|mei/i.test(nm)) v = me.sei;
        else if (/(名$|first|mei)/i.test(nm)) v = me.mei;
        else v = me.name;
      }
      else if (/年齢|生年|性別|物件|納品|品番|型番|台数|数量|予約|希望日|来店|注文|ご予算|予算|面積|坪/.test(L) && (el.required || /必須|\*/.test(L))) special.push(L.slice(0, 30));
      if (v !== null && v !== undefined) { if (!el.value) set(el, v); filled.push(L.slice(0, 15) + '=' + v.slice(0, 12)); }
      else if (el.required || /必須/.test(L)) special.push('?' + L.slice(0, 30));
    }
    const tas = [...form.querySelectorAll('textarea')].filter(vis);
    if (!tas.length) return { ok: false, reason: 'no_textarea' };
    const main = tas.sort((a, b) => (b.rows || 2) * (b.offsetHeight || 1) - (a.rows || 2) * (a.offsetHeight || 1))[0];
    if (main.maxLength > 0 && msg.length > main.maxLength) return { ok: false, reason: 'maxlength', special: ['本文上限' + main.maxLength + '字'], filled };
    set(main, msg); filled.push('textarea');
    for (const ta of tas) if (ta !== main && !ta.value && (ta.required || /必須/.test(labelOf(ta)))) set(ta, '特になし');
    // select
    const PREF_OK = /その他|協業|提携|パートナー|代理店|業務|ビジネス|法人|一般|ご相談|お問い合わせ/;
    for (const s of [...form.querySelectorAll('select')].filter(vis)) {
      const L = labelOf(s); const opts = [...s.options].filter(o => o.value && !/選択|---|please/i.test(o.text));
      if (!opts.length) continue;
      let o = null;
      if (/都道府県|pref|所在地|居住地|地域|エリア/i.test(L) || (opts.length >= 40 && opts.some(x => x.text === '北海道'))) o = opts.find(x => x.text.includes('東京'));
      else if (/年|月|日/.test(L) && /生年|誕生/.test(L)) { special.push('select:' + L.slice(0, 20)); continue; }
      else o = opts.find(x => /協業|提携|パートナー|代理店/.test(x.text)) || opts.find(x => /その他/.test(x.text)) || opts.find(x => PREF_OK.test(x.text));
      if (!o) { if (s.required || /必須/.test(L)) special.push('select:' + L.slice(0, 30) + '[' + opts.map(x => x.text).join('/').slice(0, 60) + ']'); continue; }
      set(s, o.value); filled.push('sel=' + o.text.slice(0, 10));
    }
    // radio
    const groups = {};
    for (const r of [...form.querySelectorAll('input[type=radio]')]) { (groups[r.name] = groups[r.name] || []).push(r); }
    for (const [nm, rs] of Object.entries(groups)) {
      if (rs.some(r => r.checked)) continue;
      const txt = r => (r.closest('label')?.innerText || r.value || '') + ' ' + (r.id ? document.querySelector(`label[for="${CSS.escape(r.id)}"]`)?.innerText || '' : '');
      let r = rs.find(x => /協業|提携|パートナー|代理店/.test(txt(x))) || rs.find(x => /メール|e-?mail/i.test(txt(x))) || rs.find(x => /その他/.test(txt(x))) || rs.find(x => PREF_OK.test(txt(x))) || rs.find(x => /法人|企業/.test(txt(x)));
      const L = labelOf(rs[0]);
      if (!r && /性別|gender/i.test(L)) r = rs.find(x => /男/.test(txt(x)));
      if (!r) { if (rs.some(x => x.required) || /必須/.test(L)) special.push('radio:' + rs.map(txt).join('/').slice(0, 60)); continue; }
      r.click(); filled.push('radio=' + txt(r).trim().slice(0, 10));
    }
    // checkbox: 同意は必ず。用件の複数選択は「その他」系を1つ
    const cbs = [...form.querySelectorAll('input[type=checkbox]')];
    const cbtxt = c => ((c.closest('label')?.innerText || '') + ' ' + (c.id ? document.querySelector(`label[for="${CSS.escape(c.id)}"]`)?.innerText || '' : '') + ' ' + c.name + ' ' + c.value);
    for (const c of cbs) if (!c.checked && /同意|承諾|個人情報|プライバシー|privacy|agree|accept|規約/i.test(cbtxt(c) + ' ' + labelOf(c))) { c.click(); filled.push('agree'); }
    const cbGroups = {};
    for (const c of cbs) if (!/同意|承諾|個人情報|プライバシー|privacy|agree|accept|規約/i.test(cbtxt(c))) (cbGroups[c.name] = cbGroups[c.name] || []).push(c);
    for (const [nm, cs] of Object.entries(cbGroups)) {
      if (cs.some(c => c.checked)) continue;
      const L = labelOf(cs[0]);
      if (!(cs.some(c => c.required) || /必須/.test(L))) continue;
      const c = cs.find(x => /協業|提携|パートナー|代理店/.test(cbtxt(x))) || cs.find(x => /その他/.test(cbtxt(x))) || cs.find(x => PREF_OK.test(cbtxt(x)));
      if (!c) { special.push('checkbox:' + cs.map(cbtxt).join('/').slice(0, 60)); continue; }
      c.click(); filled.push('cb=' + cbtxt(c).trim().slice(0, 10));
    }
    // 必須なのに空のまま残った欄があれば送らない
    for (const el of [...form.querySelectorAll('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]):not([type=image]),textarea,select')].filter(vis)) {
      if (!el.value && (el.required || el.getAttribute('aria-required') === 'true' || /必須/.test(labelOf(el)))) special.push('empty:' + labelOf(el).slice(0, 30));
    }
    if (special.length) return { ok: false, reason: 'special', special, filled };
    return { ok: true, filled };
  }, [me, msg, subject]);
}

const SUCCESS_RE = /ありがとうございま|送信(が)?完了|送信いたしました|送信しました|受け?付け?(いた)?しました|受付が完了|お問い合わせ(を|いただき)|送信されました|thank you|has been sent|successfully/i;
const CONFIRM_RE = /確認画面|入力内容(の|を)?確認|以下の内容で|ご確認(の上|ください)|内容をご確認/;
const ERROR_RE = /入力してください|必須項目です|正しく入力|選択してください|入力されていません|不正な|invalid|is required|エラーが(発生|あります)/i;

async function clickSubmit(page, prefer) {
  const btns = await page.$$('input[type=submit],button[type=submit],button:not([type]),input[type=button],input[type=image],a.btn,button');
  const scored = [];
  for (const b of btns) {
    if (!(await b.isVisible().catch(() => false))) continue;
    const t = ((await b.innerText().catch(() => '')) + ' ' + ((await b.getAttribute('value')) || '') + ' ' + ((await b.getAttribute('alt')) || '')).trim();
    if (/戻る|修正|back|リセット|reset|クリア|検索|search|ログイン|閉じる|メルマガ|登録する$/i.test(t)) continue;
    let s = 0;
    if (prefer === 'send' && /送信|送る|この内容で|submit|send|完了|申し?込/i.test(t)) s += 5;
    if (prefer === 'confirm' && /確認|次へ|進む|confirm|next/i.test(t)) s += 4;
    if (/送信|確認|submit|send|次へ|この内容で|申し?込/i.test(t)) s += 3;
    if (await b.evaluate(e => !!e.closest('form')?.querySelector('textarea, input[type=hidden]'))) s += 1;
    if (s) scored.push({ b, s, t });
  }
  scored.sort((a, b) => b.s - a.s);
  if (!scored.length) return null;
  await scored[0].b.click({ timeout: 8000 }).catch(() => scored[0].b.evaluate(e => e.click()));
  return scored[0].t.slice(0, 20);
}

async function bodyText(page) { return (await page.evaluate(() => document.body?.innerText || '').catch(() => '')).replace(/\s+/g, ' '); }

async function processOne(browser, t) {
  const ctx = await browser.newContext({ locale: 'ja-JP', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', viewport: { width: 1280, height: 1600 } });
  const page = await ctx.newPage();
  page.on('dialog', d => d.accept().catch(() => {}));
  const res = { domain: t.domain, company: t.company, seg: t.seg, variant: variant(t), hp: t.hp };
  try {
    let hp = t.hp.startsWith('http') ? t.hp : 'https://' + t.hp;
    try { await page.goto(hp, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
    catch { hp = hp.replace('https://', 'http://'); await page.goto(hp, { waitUntil: 'domcontentloaded', timeout: 25000 }); }
    await page.waitForTimeout(1500);
    let formUrl = null;
    if (await pageHasForm(page) && CONTACT_RE.test(page.url())) formUrl = page.url();
    if (!formUrl) {
      const c = await findContactUrl(page, hp);
      if (!c) return { ...res, status: 'skip_noform', detail: 'no contact link' };
      await page.goto(c, { waitUntil: 'domcontentloaded', timeout: 25000 }); await page.waitForTimeout(2000);
      formUrl = page.url();
      if (!(await pageHasForm(page))) {
        // 埋め込み iframe フォームは src を直接開く
        const ifr = await page.$$eval('iframe[src]', fs => fs.map(f => f.src).filter(s => /form|contact|inquiry|hubspot|formrun|pardot|ssl|mail/i.test(s)));
        if (ifr.length) { await page.goto(ifr[0], { waitUntil: 'domcontentloaded', timeout: 25000 }); await page.waitForTimeout(2000); formUrl = page.url(); }
      }
      if (!(await pageHasForm(page))) {
        // 一段だけ深掘り（「その他のお問い合わせ」「法人のお客様」）
        const sub = await page.$$eval('a[href]', as => as.map(a => ({ h: a.href, t: (a.innerText || '').trim() })).filter(x => /その他|法人|企業|一般|ご相談|お問い?合わせ(フォーム)?$|フォーム/.test(x.t) && !/採用|見積|資料|カタログ|予約/.test(x.t)).map(x => x.h));
        if (sub.length) { await page.goto(sub[0], { waitUntil: 'domcontentloaded', timeout: 25000 }); await page.waitForTimeout(2000); formUrl = page.url(); }
      }
      if (!(await pageHasForm(page))) return { ...res, status: 'skip_noform', formUrl, detail: 'contact page without textarea' };
    }
    res.formUrl = formUrl;
    if (sentForms.has(formUrl.split('?')[0])) return { ...res, status: 'skip_dup_form' };
    const pageTxt = await bodyText(page);
    if (/採用|エントリー|応募/.test(pageTxt.slice(0, 300)) && !/お問い?合わせ/.test(pageTxt.slice(0, 300))) return { ...res, status: 'skip_special', detail: 'recruit page' };
    if (NG_SALES_RE.test(pageTxt)) return { ...res, status: 'skip_special', detail: '営業お断り ' + (pageTxt.match(NG_SALES_RE) || [''])[0] };
    const cap = await captchaKind(page);
    if (cap) return { ...res, status: 'skip_captcha', detail: cap };
    const f = await fillForm(page, ME, message(t), T.subject);
    res.filled = f.filled;
    if (!f.ok) return { ...res, status: 'skip_special', detail: f.reason + ' ' + (f.special || []).join(' | ') };
    const shot = path.join(SHOTS, t.domain.replace(/[^a-z0-9.-]/gi, '_') + (DRY ? '_dry' : '') + '.png');
    if (DRY) { await page.screenshot({ path: shot, fullPage: true }).catch(() => {}); return { ...res, status: 'dry_ok', shot }; }
    // 送信
    const before = page.url();
    let clicked = await clickSubmit(page, 'confirm');
    if (!clicked) return { ...res, status: 'fail_nobutton' };
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(3500);
    for (let step = 0; step < 3; step++) {
      const txt = await bodyText(page);
      const taVisible = await page.evaluate(() => [...document.querySelectorAll('textarea')].some(t => t.offsetParent !== null && t.value.length > 50)).catch(() => false);
      if (SUCCESS_RE.test(txt) && !taVisible && !CONFIRM_RE.test(txt.slice(0, 2000))) { await page.screenshot({ path: shot, fullPage: false }).catch(() => {}); return { ...res, status: 'sent', step, shot }; }
      const cf7 = await page.$eval('.wpcf7-response-output', e => e.innerText).catch(() => '');
      if (cf7 && SUCCESS_RE.test(cf7)) { await page.screenshot({ path: shot }).catch(() => {}); return { ...res, status: 'sent', detail: 'cf7', shot }; }
      if (cf7 && ERROR_RE.test(cf7)) return { ...res, status: 'fail_validation', detail: cf7.slice(0, 80) };
      const capNow = await captchaKind(page);
      if (capNow) return { ...res, status: 'skip_captcha', detail: capNow + ' after submit' };
      if (CONFIRM_RE.test(txt) || (page.url() !== before && !taVisible)) {
        clicked = await clickSubmit(page, 'send');
        if (!clicked) break;
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}); await page.waitForTimeout(3500);
        continue;
      }
      if (taVisible && ERROR_RE.test(txt)) { const m = txt.match(new RegExp('.{0,30}(' + ERROR_RE.source + ').{0,20}', 'i')); return { ...res, status: 'fail_validation', detail: m ? m[0] : '' }; }
      break;
    }
    await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
    const txt = await bodyText(page);
    if (SUCCESS_RE.test(txt)) return { ...res, status: 'sent', detail: 'success text (form still visible)', shot };
    return { ...res, status: 'sent_unknown', detail: txt.slice(0, 80), shot, finalUrl: page.url() };
  } catch (e) {
    return { ...res, status: 'fail_error', detail: String(e.message || e).slice(0, 120) };
  } finally { await ctx.close().catch(() => {}); }
}

(async () => {
  if (fs.existsSync(path.join(DIR, 'STOP'))) { console.log('STOP file present'); return; }
  const lock = path.join(DIR, 'live.lock');
  if (!DRY) { if (fs.existsSync(lock)) { console.log('live.lock exists; another live run?'); return; } fs.writeFileSync(lock, String(process.pid)); }
  const browser = await chromium.launch(EXE ? { executablePath: EXE } : { channel: 'chrome' });
  const q = [...targets]; const counts = {};
  async function worker() {
    while (q.length) {
      if (fs.existsSync(path.join(DIR, 'STOP'))) return;
      const t = q.shift();
      const r = await processOne(browser, t);
      record(r); counts[r.status] = (counts[r.status] || 0) + 1;
      if (/^sent/.test(r.status) && r.formUrl) sentForms.add(r.formUrl.split('?')[0]);
      console.log(new Date().toISOString().slice(11, 19), r.status.padEnd(15), t.domain, (r.detail || '').slice(0, 70));
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  await browser.close();
  if (!DRY) fs.unlinkSync(lock);
  console.log('SUMMARY', JSON.stringify(counts));
})();
