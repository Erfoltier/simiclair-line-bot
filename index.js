// シミクレール LINE公式アカウント 自動応答ボット
//
// 設計方針（戦略レポートより）:
//   1. 一般的なFAQ（送料・発送・支払い・返品・使い方・診察パスワード）→ 固定回答で即答
//   2. 効能・診断的な質問（ニキビに効く？等）→ 個人差がある旨の定型文で必ずかわす（AIに自由回答させない）
//   3. 健康被害の申告（かぶれ・赤み等）→ 受付メッセージだけ自動で返し、スタッフが受信箱から個別に返信する
//   4. 注文トラブル（未着・破損等）→ 同上、スタッフ対応に回す
//   5. 上記いずれにも一致しない場合のみ、簡易なフォールバック文を返す
//
// 医師・看護師へのエスカレーション経路は意図的に作っていない（05章の設計に準拠）。
// 3・4は受付メッセージだけを自動で返し、回答そのものはしない。
// LINE公式アカウントマネージャーの受信箱をスタッフが確認し、そこから直接返信する運用。
//
// 人手を減らすための追加機能（2026年11月）:
//   - 注文トラブルの受付文で、注文番号・名前・内容（破損・誤配送は写真）を最初にもらう
//   - スタッフ対応に回る返信には、営業時間外なら「翌営業日以降のご連絡」の一文を添える
//   - 健康被害の連絡が来たら、スタッフのLINEグループ等へすぐ通知する（STAFF_NOTIFY_TO）
//   - リッチメニューのボタン文言には、決まった返信を返す（MENU_REPLIES）
//   - 注文番号＋注文時のメールアドレス（または電話番号）が送られたら、Shopifyで配送状況を調べて返す
//     （SHOPIFY_SHOP / SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET が設定されているときだけ動く）

const line = require('@line/bot-sdk');
const express = require('express');
const holidayJp = require('@holiday-jp/holiday_jp');

const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});

const app = express();

// ---------------------------------------------------------------------------
// ルール定義
// 上から順に判定し、最初に一致したルールを採用する。
// 回答の数字（送料・発送日数・支払い方法・返品条件）は、Shopifyの設定と
// ポリシーページ（2026年11月時点）に合わせている。設定を変えたらここも直すこと。
// 変更後は `node test/run-tests.js` で判定が崩れていないか確認する。
// ---------------------------------------------------------------------------

const HOLD_MESSAGE =
  'お問い合わせありがとうございます。担当スタッフより確認のうえ、順次ご連絡いたします。';

// 注文トラブルの受付文：スタッフが聞き返さずに済むよう、必要な情報を最初にもらう
const ORDER_TROUBLE_MESSAGE =
  'お問い合わせありがとうございます。確認のため、ご注文番号・ご注文者のお名前・お困りの内容をこのトークにお送りください（破損・誤配送の場合は、商品の状態がわかる写真もあわせてお送りください）。\n' +
  '担当スタッフより確認のうえ、順次ご連絡いたします。';

// 配送状況の自動確認の案内（Shopify連携が設定されているときだけ添える）
const ORDER_LOOKUP_GUIDE =
  'ご注文済みの方は、ご注文番号とご注文時のメールアドレス（または電話番号）を1つのメッセージでお送りいただくと、配送状況を自動でお調べします。\n例：#1001 taro@example.com';

const EFFICACY_TEMPLATE =
  '製品の効果や使用感には個人差があり、特定の症状や肌状態に合うかどうかについては断定的にお答えできません。\n' +
  '一般的な製品特徴は各商品ページをご確認ください。気になる症状がある場合や、妊娠・授乳中、肌が敏感な時期のご使用については、医師にご相談ください。';

const rules = [
  // --- 健康被害の申告：受付メッセージのみ返し、スタッフが受信箱から個別対応（最優先） ---
  {
    type: 'adverse_event',
    keywords: [
      'かぶれ', '赤み', '赤く', '腫れ', 'かゆ', '痒', 'アレルギー', '湿疹',
      '痛', 'ヒリヒリ', 'ピリピリ', 'ひりひり', 'ヒリ', 'ひり', 'つっぱ', '赤い', '発疹', 'ほてり', 'ほてる', '荒れ', 'ただれ', 'ブツブツ', 'ぶつぶつ', '炎症', 'しみる', 'チクチク', 'ちくちく',
    ],
    staff: true,
    notify: true,
    handle: () => HOLD_MESSAGE,
  },

  // --- 診察・購入パスワード（医療機関専売品）：「パスワードを間違えた」を注文トラブルと誤判定しないよう先に判定 ---
  {
    type: 'faq_password',
    keywords: ['パスワード', '診察', 'カウンセリング', '予約', '購入できない', '買えない', '先に進めない', '進めません', '進めない',
      '買い方', '購入方法', '購入の仕方', 'どうやったら買', 'どうすれば買', '専売', 'カートで', 'カートから'],
    handle: () =>
      'ゼオスキン（ZO SKIN HEALTH）は医療機関専売品のため、医師のカウンセリングを受けた方にのみ購入パスワードをお伝えしています。\n' +
      'パスワードはカート画面の「ご購入手続きへ」の上に入力してください。カウンセリングのご希望や、パスワードがご不明・入力できない場合は、このトークにその旨をお送りください。担当スタッフよりご連絡いたします。',
  },

  // --- 注文トラブル：受付メッセージのみ返し、スタッフが個別対応 ---
  {
    type: 'order_trouble',
    keywords: [
      '届かない', '届きません', '届いていない', '届いてない', '未着', '破損', '割れ', '漏れ',
      '間違', '違う商品', '違うもの', '別の商品', '誤配送', 'キャンセル', '不良品', '足りない', '少な', '取り消', '取消', '変更', '変えたい', '入っていない', '入ってない', '入っていません', '届いていません', 'つぶれ', '潰れ', '凹', '追跡', '動いていない', '動いてない',
      'まだ来', '来ない', '来てない', '来ません', 'へこ', 'やめたい', '違うのが', '2個届', '二重', '重複',
    ],
    staff: true,
    handle: () => ORDER_TROUBLE_MESSAGE + (orderLookupEnabled() ? '\n\n' + ORDER_LOOKUP_GUIDE : ''),
  },

  // --- 効能・体質の質問：定型文でかわす（医師・カウンセラーへの取り次ぎはしない） ---
  {
    type: 'efficacy_question',
    keywords: [
      '効き', '効く', '効果', '治', '改善', '消え', '薄く', '合います', '合うか', '合いますか',
      'ニキビ', 'にきび', 'シミ', '肝斑', 'くすみ', '毛穴', 'しわ', 'シワ', 'たるみ',
      '敏感肌', 'アトピー', '肌質', '乾燥肌', '脂性肌', '妊娠', '授乳', '副作用', 'おすすめ', 'オススメ', 'そばかす',
    ],
    // 「間に合いますか」（発送の質問）が「合いますか」に一致しないよう除外する
    unless: ['間に合'],
    handle: () => EFFICACY_TEMPLATE,
  },

  // --- FAQ：固定回答 ---
  {
    type: 'faq_shipping',
    keywords: ['送料', '配送料', '送り方', '海外', '国外', '離島', 'アメリカ', '外国'],
    handle: () =>
      '送料は全国一律1,000円（税込）です。1回のご注文の商品合計が15,000円（税込）以上の場合は送料無料です。配送は日本国内のみとなります。',
  },
  {
    type: 'faq_delivery_time',
    keywords: ['何日', 'いつ届', '届くまで', '発送', '到着', '届きますか', '届く',
      '出荷', 'どのくらいで届', 'どれくらいで届', 'どのくらいで来', 'どれくらいで来', 'どのくらいで着', 'どれくらいで着', '間に合', '明日まで', 'までに届', 'までに欲し', '着きますか', 'いつ着', 'に着く'],
    handle: () =>
      'ご入金（決済）の確認後、5営業日以内に発送いたします（土日祝・年末年始は休業日です）。発送時に追跡番号をメールでお知らせします。銀行振込の場合は、ご入金の確認後の発送となります。' +
      (orderLookupEnabled() ? '\n' + ORDER_LOOKUP_GUIDE : ''),
  },
  {
    type: 'faq_payment',
    keywords: [
      '支払', '払え', '払い', '決済', 'クレジット', 'クレカ', 'カード払', 'カードで', 'カード使', 'カードは使', '振込', '振り込', '振込先', '口座', '分割',
      'コンビニ', 'paypay', 'ペイペイ', 'apple pay', 'applepay', 'google pay', 'googlepay', 'shop pay', '代引', '代金引換', '後払', 'paypal', 'ペイパル', '銀行',
    ],
    handle: () =>
      'お支払い方法は、クレジットカード、Apple Pay、Google Pay、Shop Pay、銀行振込（前払い）です。\n' +
      '銀行振込の振込先は、ご注文後の画面とメールでご案内します。ご注文日から7日以内にお振込みください（振込手数料はお客様のご負担です）。\n' +
      '代金引換・後払い・コンビニ払い・PayPayは現在お取り扱いしておりません。',
  },
  {
    type: 'faq_subscription',
    keywords: ['定期', '休止', '解約', 'スキップ', 'サブスク', '毎月'],
    handle: () => '現在、定期便（定期購入）のお取り扱いはございません。ご必要な都度、ご注文いただけますようお願いいたします。',
  },
  {
    type: 'faq_return',
    keywords: ['返品', '交換', '返送', '返せ', '返したい', '返金', '送り返'],
    handle: () =>
      '商品に不良・破損があった場合、またはご注文と異なる商品が届いた場合に限り、商品到着後7日以内にご連絡いただければ、交換または返金にて対応いたします（返送料は当社負担）。\n' +
      'お客様のご都合（肌に合わない、イメージ違い等）による返品・交換はお受けしておりません。\n' +
      'ご連絡の際は、ご注文番号・お名前と、不良や破損の状況がわかる写真をこのトークにお送りください。返送方法は当社よりご案内します（事前のご連絡なくご返送いただいた商品はお受けできない場合があります）。',
  },
  {
    type: 'faq_howto',
    keywords: ['使い方', '使用方法', '塗り方', '順番', '使う順', 'つける順', 'どっちが先', 'どちらが先', '先に使', '前に使', '後に使', 'あとに使', '使用量', '使う量', '朝と夜', '朝晩', '朝だけ', '夜だけ', 'どちらに使',
      'どれくらい使', 'どのくらい使', '1回に', '何回', 'どうやって使', '使っていい', '使ってもいい', '朝も使', '夜も使', 'の量', '量は'],
    handle: () =>
      '基本的な使用順序は「洗顔 → 化粧水 → 美容液 → クリーム → 日焼け止め（朝）」です。商品ごとの使用方法・使用量は各商品ページに記載していますので、あわせてご確認ください。',
  },
];

// 店名「シミクレール」に含まれる「シミ」で効能の定型文が返らないよう、
// 判定前に店名を取り除き、全角・半角や大文字・小文字の違いをそろえる。
// あわせて、キーワードを含むが問い合わせとは無関係な言葉（「ポイントカード」の「カード」、
// 「痛快」の「痛」、「変更点」の「変更」）も取り除き、誤検知を防ぐ。
const NEUTRAL_WORDS = ['ポイントカード', '痛快', '変更点'];

function normalize(text) {
  let t = text
    .normalize('NFKC')
    .replace(/シミクレール|simiclair/gi, '')
    .toLowerCase();
  for (const w of NEUTRAL_WORDS) t = t.split(w).join('');
  return t;
}

// キーワード一致でルールを判定する。unless の言葉を含む場合はそのルールを飛ばす。
function matchRule(text) {
  const t = normalize(text);
  for (const rule of rules) {
    if (rule.unless && rule.unless.some((w) => t.includes(w))) continue;
    if (rule.keywords.some((kw) => t.includes(kw.normalize('NFKC').toLowerCase()))) {
      return rule;
    }
  }
  return null;
}

const FALLBACK_MESSAGE =
  'お問い合わせありがとうございます。内容を確認し、担当スタッフより順次ご連絡いたします。お急ぎの場合はお時間をいただく場合がございます。';

function ruleByType(type) {
  return rules.find((r) => r.type === type);
}

// ---------------------------------------------------------------------------
// 営業時間（平日10:00〜19:00、土日祝・年末年始は休業）
// サーバーの時刻設定に関係なく、日本時間で判定する。
// 年末年始の休業日は 12/29〜1/3 としている。変える場合は isYearEndHoliday を直す。
// ---------------------------------------------------------------------------

const BUSINESS_OPEN_HOUR = 10;
const BUSINESS_CLOSE_HOUR = 19;

const OUT_OF_HOURS_NOTE =
  '※ただいま営業時間外のため、担当スタッフからのご連絡は翌営業日以降となります（営業時間：平日10:00〜19:00、土日祝・年末年始を除く）。';

function jstParts(now) {
  const j = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return {
    y: j.getUTCFullYear(), m: j.getUTCMonth() + 1, d: j.getUTCDate(),
    dow: j.getUTCDay(), h: j.getUTCHours(), min: j.getUTCMinutes(),
  };
}

function isYearEndHoliday(m, d) {
  return (m === 12 && d >= 29) || (m === 1 && d <= 3);
}

function isBusinessDay(p) {
  if (p.dow === 0 || p.dow === 6) return false;
  if (isYearEndHoliday(p.m, p.d)) return false;
  // 日本時間の日付を文字列で渡す（Date を渡すとサーバーのタイムゾーンで日付がずれるおそれがある）
  const ymd = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  return !holidayJp.isHoliday(ymd);
}

function isBusinessHours(now) {
  const p = jstParts(now);
  return isBusinessDay(p) && p.h >= BUSINESS_OPEN_HOUR && p.h < BUSINESS_CLOSE_HOUR;
}

function formatJst(now) {
  const p = jstParts(now);
  return `${p.m}/${p.d} ${p.h}:${String(p.min).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// リッチメニュー（トーク画面下のボタン）
// ボタンを押すと、ここに書いた文言がお客様から送られる。文言はリッチメニューの設定と一字一句そろえること。
// 「商品を見る」はストアのトップページへのリンクなので、ボットには何も届かない。
// 「送料・お届けについて」「お支払い方法について」は以前のメニュー用。差し替え前の画像でも困らないよう残している。
// ---------------------------------------------------------------------------

const MENU_REPLIES = {
  '送料・お届けについて': () => ({
    type: 'menu_shipping',
    text: ruleByType('faq_shipping').handle() + '\n' + ruleByType('faq_delivery_time').handle(),
  }),
  // 「送料・お届け」と「お支払い方法」を1つにまとめたボタン（2026年11月〜。空いた場所は「商品を見る」のリンク）
  '送料・お支払いについて': () => ({
    type: 'menu_shipping_payment',
    text: ruleByType('faq_shipping').handle() + '\n' + ruleByType('faq_delivery_time').handle() + '\n\n' + ruleByType('faq_payment').handle(),
  }),
  'お支払い方法について': () => ({ type: 'menu_payment', text: ruleByType('faq_payment').handle() }),
  '返品・交換について': () => ({ type: 'menu_return', text: ruleByType('faq_return').handle() }),
  '専売品の購入方法': () => ({ type: 'menu_password', text: ruleByType('faq_password').handle() }),
  'ご注文状況の確認': () => (orderLookupEnabled()
    ? { type: 'menu_order_status', text: ORDER_LOOKUP_GUIDE.replace('ご注文済みの方は、', '') }
    : { type: 'menu_order_status', staff: true,
        text: 'ご注文番号とご注文者のお名前をこのトークにお送りください。担当スタッフより配送状況を確認のうえ、順次ご連絡いたします。' }),
  'その他のお問い合わせ': () => ({
    type: 'menu_contact', staff: true,
    text: 'お問い合わせ内容をこのトークにお送りください。担当スタッフより確認のうえ、順次ご連絡いたします。',
  }),
};

function matchMenu(text) {
  const key = text.normalize('NFKC').trim();
  for (const label of Object.keys(MENU_REPLIES)) {
    if (label.normalize('NFKC') === key) return MENU_REPLIES[label]();
  }
  return null;
}

// ---------------------------------------------------------------------------
// 配送状況の自動確認（Shopify）
// 他人の注文が見えないよう、注文番号に加えて、注文時のメールアドレスか電話番号が一致したときだけ答える。
// 見つからない場合と一致しない場合は同じ返信にする（どちらか分からないようにするため）。
// メールアドレス・電話番号はログに出さない。
// ---------------------------------------------------------------------------

const SHOPIFY_SHOP = process.env.SHOPIFY_SHOP; // 例：ehhk60-bq（.myshopify.com の前の部分）
const SHOPIFY_CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-10';

function orderLookupEnabled() {
  return Boolean(SHOPIFY_SHOP && SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?<![\d#])(?:\+?81[-\s]?|0)\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}(?!\d)/;

// 電話番号を「0から始まる国内の数字だけ」の形にそろえる（+81 90-1234-5678 → 09012345678）
function normalizePhone(s) {
  if (!s) return null;
  let d = String(s).normalize('NFKC').replace(/\D/g, '');
  if (d.startsWith('81') && (d.length === 11 || d.length === 12)) d = '0' + d.slice(2);
  return d.length === 10 || d.length === 11 ? d : null;
}

// 注文番号・メールアドレス・電話番号を読み取る（全角・半角、「〜です」などの語尾、区切りの揺れに対応）
// explicit：注文番号だと分かる書き方か（#1001、注文番号1001、No.1001、1001番、数字だけのメッセージ）。
//   「15000円以上で送料無料？」のような金額を注文番号と取り違えないよう、連絡先がないときはこれを条件にする。
function parseOrderParts(text) {
  let rest = text.normalize('NFKC')
    .replace(/(\d)[‐‑‒–—―ー−ｰ~〜](?=\d)/g, '$1-')           // 電話番号の「ー」「〜」などをハイフンに
    .replace(/#\s?(\d{4,7})(?=[A-Za-z])/g, '#$1 ')          // 「#1001taro@…」のように続けて書かれた場合
    .replace(/#\s?(\d{14,18})(?!\d)/g, (m, run) => {          // 「#100109012345678」のように電話番号と続けて書かれた場合
      for (let n = 4; n <= 7; n++) {                             // 残りが0から始まる10〜11桁（電話番号）になる切れ目で分ける
        const tail = run.slice(n);
        if (tail[0] === '0' && (tail.length === 10 || tail.length === 11)) return `#${run.slice(0, n)} ${tail}`;
      }
      return m;
    });
  const emailMatch = rest.match(EMAIL_RE);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;
  if (emailMatch) rest = rest.replace(emailMatch[0], ' ');
  let phone = null;
  const phoneMatch = rest.match(PHONE_RE);
  if (phoneMatch) {
    phone = normalizePhone(phoneMatch[0]);
    if (phone) rest = rest.replace(phoneMatch[0], ' ');
  }
  const hash = rest.match(/#\s?(\d{4,7})(?!\d)/);
  const plain = rest.match(/(?<!\d)(\d{4,7})(?!\d)/);
  const orderMatch = hash || plain;
  const bare = rest.replace(/[\s、。,.!！?？:：]/g, '');
  const explicit = Boolean(hash) || (Boolean(plain) && (/注文|no\.?\s?\d|番号|\d番/i.test(rest) || /^\d{4,7}(です)?$/.test(bare)));
  return { orderNumber: orderMatch ? orderMatch[1] : null, email, phone, explicit };
}

// 「注文番号」と「メールアドレスまたは電話番号」が両方含まれているときだけ、確認の依頼とみなす
function parseOrderLookup(text) {
  const p = parseOrderParts(text);
  if (!p.orderNumber || (!p.email && !p.phone)) return null;
  return { orderNumber: p.orderNumber, email: p.email, phone: p.phone };
}

// 2回に分けて送られた場合（先に「#1001」、あとで連絡先）のため、注文番号だけを15分間覚えておく。
// 覚えるのは注文番号だけで、メールアドレス・電話番号は保存しない。サーバーが再起動すると消える。
const PENDING_MS = 15 * 60 * 1000;
const pendingOrders = new Map();
function rememberOrder(userId, orderNumber, now) {
  if (userId) pendingOrders.set(userId, { orderNumber, at: now.getTime() });
}
function takePendingOrder(userId, now) {
  const p = userId && pendingOrders.get(userId);
  if (!p) return null;
  pendingOrders.delete(userId);
  return now.getTime() - p.at <= PENDING_MS ? p.orderNumber : null;
}

const ORDER_NEED_CONTACT = (n) =>
  `ご注文 #${n} の配送状況をお調べします。ご注文時のメールアドレスまたは電話番号をお送りください。`;
const ORDER_NEED_NUMBER =
  '配送状況をお調べするには、ご注文番号もお送りください（例：#1001 taro@example.com）。ご注文番号はご注文確認メールに記載しています。';

let shopifyToken = null;
let shopifyTokenExpiresAt = 0;

// Dev Dashboard のアプリの client ID / secret から、24時間有効な読み取り用トークンを取得する（client credentials grant）
async function getShopifyToken() {
  if (shopifyToken && Date.now() < shopifyTokenExpiresAt - 60 * 1000) return shopifyToken;
  const res = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: SHOPIFY_CLIENT_ID,
      client_secret: SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
  const body = await res.json();
  shopifyToken = body.access_token;
  shopifyTokenExpiresAt = Date.now() + body.expires_in * 1000;
  return shopifyToken;
}

const ORDER_QUERY = `query ($q: String!) {
  orders(first: 1, query: $q) {
    nodes {
      name email phone cancelledAt displayFinancialStatus displayFulfillmentStatus
      shippingAddress { phone }
      fulfillments(first: 5) { status trackingInfo(first: 3) { company number url } }
    }
  }
}`;

async function findOrderInShopify(orderNumber) {
  const res = await fetch(`https://${SHOPIFY_SHOP}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': await getShopifyToken() },
    body: JSON.stringify({ query: ORDER_QUERY, variables: { q: `name:${orderNumber}` } }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL request failed: ${res.status}`);
  const body = await res.json();
  if (body.errors && body.errors.length) throw new Error('Shopify GraphQL errors: ' + body.errors.map((e) => e.message).join('; '));
  const order = body.data.orders.nodes[0];
  // 検索は前方一致などで別の注文が返ることがあるため、注文番号が完全に一致するものだけ使う
  return order && order.name === `#${orderNumber}` ? order : null;
}

function orderMatchesContact(order, { email, phone }) {
  if (email && order.email && order.email.toLowerCase() === email) return true;
  if (phone) {
    const phones = [order.phone, order.shippingAddress && order.shippingAddress.phone].map(normalizePhone);
    if (phones.includes(phone)) return true;
  }
  return false;
}

// 配送会社の名前をそろえ、追跡URLが入っていないときは各社の追跡ページを組み立てる。
// Shopify やプラスシッピングが入れる名前（「Yamato (JA)」など）は、お客様向けに日本語の社名で表示する。
const CARRIERS = [
  { name: 'ヤマト運輸', match: /yamato|kuroneko|ヤマト|クロネコ|宅急便|ネコポス/i,
    url: (n) => `https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=${n}` },
  { name: '佐川急便', match: /sagawa|佐川|飛脚/i,
    url: (n) => `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${n}` },
  { name: '日本郵便', match: /japan\s*post|jp\s*post|日本郵便|ゆうパック|ゆうパケット|クリックポスト|郵便/i,
    url: (n) => `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${n}&locale=ja` },
];

function trackingLines(t) {
  const carrier = CARRIERS.find((c) => c.match.test(t.company || ''));
  const name = carrier ? carrier.name : (t.company || '－');
  const number = String(t.number).normalize('NFKC').replace(/[^0-9A-Za-z]/g, '');
  const url = t.url || (carrier && number ? carrier.url(number) : null);
  const lines = [`配送会社：${name}／追跡番号：${t.number}`];
  if (url) lines.push(`配送状況：${url}`);
  return lines;
}

function describeOrder(order) {
  const lines = [`ご注文 ${order.name} の状況をお知らせします。`];
  if (order.cancelledAt) {
    lines.push('このご注文はキャンセル済みです。');
    return lines.join('\n');
  }
  const pay = order.displayFinancialStatus;
  if (pay === 'PENDING') lines.push('お支払い：お振込みの確認待ちです。ご注文日から7日以内にお振込みください。');
  else if (pay === 'REFUNDED') lines.push('お支払い：返金済みです。');
  else if (pay === 'VOIDED' || pay === 'EXPIRED') lines.push('お支払い：お手続きが完了していません。');
  else lines.push('お支払い：確認済みです。');

  const ship = order.displayFulfillmentStatus;
  const tracking = (order.fulfillments || [])
    .flatMap((f) => f.trackingInfo || [])
    .filter((t) => t && t.number);
  if (ship === 'FULFILLED' || ship === 'PARTIALLY_FULFILLED') {
    lines.push(ship === 'FULFILLED' ? '発送：発送済みです。' : '発送：一部の商品を発送済みです。残りの商品は準備ができ次第発送いたします。');
    for (const t of tracking) lines.push(...trackingLines(t));
    if (!tracking.length) lines.push('追跡番号は発送完了のメールでご確認ください。');
  } else if (pay === 'PENDING') {
    lines.push('発送：お振込みの確認後、5営業日以内に発送いたします。');
  } else {
    lines.push('発送：準備中です。ご入金（決済）の確認後、5営業日以内に発送いたします（土日祝・年末年始は休業日です）。');
  }
  return lines.join('\n');
}

const ORDER_NOT_FOUND_MESSAGE =
  'ご入力いただいたご注文番号と、メールアドレス（または電話番号）に一致するご注文が見つかりませんでした。ご注文時のメールアドレス・電話番号をご確認のうえ、もう一度お送りください。\n' +
  'お困りの場合は、その旨をこのトークにお送りいただければ、担当スタッフよりご連絡いたします。';
const ORDER_LOOKUP_ERROR_MESSAGE =
  'ただいま配送状況を自動でお調べできませんでした。担当スタッフより確認のうえ、順次ご連絡いたします。';
const ORDER_LOOKUP_LIMIT_MESSAGE =
  '確認のご依頼が続いたため、自動でのお調べを一時的に止めています。担当スタッフより確認のうえ、順次ご連絡いたします。';

// 同じ人からの確認は10分に5回まで（他人の注文を総当たりで探す使い方を防ぐ）
const LOOKUP_LIMIT = 5;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;
const lookupHistory = new Map();

function allowLookup(userId, now) {
  const key = userId || 'unknown';
  const recent = (lookupHistory.get(key) || []).filter((t) => now.getTime() - t < LOOKUP_WINDOW_MS);
  if (recent.length >= LOOKUP_LIMIT) {
    lookupHistory.set(key, recent);
    return false;
  }
  recent.push(now.getTime());
  lookupHistory.set(key, recent);
  return true;
}

async function lookupOrder(req, ctx) {
  if (!allowLookup(ctx.userId, ctx.now)) return { type: 'order_lookup_limited', staff: true, text: ORDER_LOOKUP_LIMIT_MESSAGE };
  try {
    const order = await (ctx.findOrder || findOrderInShopify)(req.orderNumber);
    if (!order || !orderMatchesContact(order, req)) return { type: 'order_lookup_not_found', text: ORDER_NOT_FOUND_MESSAGE };
    return { type: 'order_lookup', text: describeOrder(order) };
  } catch (err) {
    console.error('配送状況の確認に失敗しました:', err.message);
    return { type: 'order_lookup_error', staff: true, text: ORDER_LOOKUP_ERROR_MESSAGE };
  }
}

// ---------------------------------------------------------------------------
// 返信の組み立て
// ---------------------------------------------------------------------------

// 配送状況の確認以外の返信を決める（同期処理）。
function planReply(userText) {
  const rule = matchRule(userText);
  // 健康被害は何より先に扱う（メニューや注文確認の文言に混ざっていても見落とさない）
  if (rule && rule.type === 'adverse_event') {
    return { type: rule.type, staff: true, notify: true, text: rule.handle(userText) };
  }
  const menu = matchMenu(userText);
  if (menu) return menu;
  if (!rule) return { type: 'fallback', staff: true, text: FALLBACK_MESSAGE };
  return { type: rule.type, staff: Boolean(rule.staff), notify: Boolean(rule.notify), text: rule.handle(userText) };
}

function withHoursNote(reply, now) {
  if (reply.staff && !isBusinessHours(now)) return { ...reply, text: reply.text + '\n' + OUT_OF_HOURS_NOTE };
  return reply;
}

// 1通のメッセージへの返信を決める。ctx: { now, userId, findOrder（試験用） }
async function respond(userText, ctx = {}) {
  const now = ctx.now || new Date();
  let reply = planReply(userText);
  if (reply.type !== 'adverse_event' && orderLookupEnabledFor(ctx)) {
    const parts = parseOrderParts(userText);
    const hasContact = Boolean(parts.email || parts.phone);
    let req = null;
    if (parts.orderNumber && hasContact) {
      req = { orderNumber: parts.orderNumber, email: parts.email, phone: parts.phone };
      takePendingOrder(ctx.userId, now);
    } else if (!parts.orderNumber && hasContact) {
      const pending = takePendingOrder(ctx.userId, now);
      if (pending) req = { orderNumber: pending, email: parts.email, phone: parts.phone };
      else if (reply.type === 'fallback') reply = { type: 'order_need_number', text: ORDER_NEED_NUMBER };
    } else if (parts.orderNumber && parts.explicit &&
               ['fallback', 'faq_delivery_time', 'order_trouble', 'menu_order_status'].includes(reply.type)) {
      // 注文番号だけが届いた：連絡先を聞き、番号は覚えておく
      rememberOrder(ctx.userId, parts.orderNumber, now);
      const ask = ORDER_NEED_CONTACT(parts.orderNumber);
      reply = reply.type === 'order_trouble'
        ? { ...reply, text: reply.text + '\n\n' + ask }
        : { type: 'order_need_contact', text: ask };
    }
    if (req) {
      const result = await lookupOrder(req, { ...ctx, now });
      // 注文トラブルの連絡に注文番号が添えられていた場合は、状況を返したうえでスタッフ対応にも回す
      if (reply.type === 'order_trouble') {
        reply = { ...result, staff: true, text: result.text + '\n\nお問い合わせの内容は、担当スタッフより確認のうえ、順次ご連絡いたします。' };
      } else {
        reply = result;
      }
    }
  }
  return withHoursNote(reply, now);
}

function orderLookupEnabledFor(ctx) {
  return Boolean(ctx.findOrder) || orderLookupEnabled();
}

// 試験・確認用：配送状況の確認を除いた返信の文面
function buildReply(userText, now = new Date()) {
  return withHoursNote(planReply(userText), now).text;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

// 起動確認用（Renderの無料プランのスリープを防ぐため、外部の監視サービスから定期的にアクセスさせる）。
// LINEの処理は通らず、決まった文字を返すだけ。
app.get('/health', (req, res) => {
  res.type('text/plain').send('ok');
});

app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// 署名検証エラー・JSON解析エラーを、500ではなく適切なクライアントエラーとして返す。
// （LINEの正規の送信は必ず正しい署名付きなので、ここに来るのは不正・壊れたリクエストのみ）
// Expressの既定のエラー画面はスタックトレース（サーバー内のパス）を含むため、本文は返さない。
app.use((err, req, res, next) => {
  if (err instanceof line.SignatureValidationFailed) {
    console.warn('署名検証に失敗したリクエストを拒否しました');
    res.sendStatus(401);
    return;
  }
  if (err instanceof line.JSONParseError) {
    console.warn('JSONとして読めないリクエストを拒否しました');
    res.sendStatus(400);
    return;
  }
  console.error(err);
  res.sendStatus(500);
});

// ---------------------------------------------------------------------------
// スタッフへの通知（健康被害の連絡）
// STAFF_NOTIFY_TO に、通知先のLINEグループID（Cから始まる）またはユーザーID（Uから始まる）を
// カンマ区切りで設定する。未設定なら通知しない。
// 健康に関わる内容のため、通知には本文を載せず「届いたこと」だけを知らせる。
// LINEのプッシュメッセージは、公式アカウントの月間メッセージ数に含まれる。
// ---------------------------------------------------------------------------

const STAFF_NOTIFY_TO = (process.env.STAFF_NOTIFY_TO || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

async function notifyStaff(now) {
  if (!STAFF_NOTIFY_TO.length) return;
  const text =
    `【シミクレールLINE】健康被害の可能性がある連絡が届きました（${formatJst(now)}）。\n` +
    'LINE公式アカウントマネージャーのチャットで内容を確認し、対応してください。';
  for (const to of STAFF_NOTIFY_TO) {
    try {
      await client.pushMessage({ to, messages: [{ type: 'text', text }] });
    } catch (err) {
      console.error('スタッフへの通知に失敗しました:', err.message);
    }
  }
}

async function handleEvent(event) {
  // ボットがグループに招待されたら、通知先に設定するためのグループIDを知らせる
  if (event.type === 'join' && event.source && (event.source.type === 'group' || event.source.type === 'room')) {
    const id = event.source.groupId || event.source.roomId;
    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [{
        type: 'text',
        text: 'このグループに健康被害の連絡の通知を送るには、Renderの環境変数 STAFF_NOTIFY_TO に次のIDを設定してください。\n' + id,
      }],
    });
    return;
  }

  if (event.type !== 'message' || event.message.type !== 'text') {
    return;
  }
  // スタッフのグループ内の会話には反応しない（お客様との1対1のトークだけに返信する）
  if (!event.source || event.source.type !== 'user') {
    return;
  }

  const now = new Date();
  const reply = await respond(event.message.text, { now, userId: event.source.userId });

  // 返信には期限があるため、通知より先に返信する
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text: reply.text }],
  });

  if (reply.notify) {
    await notifyStaff(now);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`シミクレール LINEボット起動：ポート ${PORT}`);
});
