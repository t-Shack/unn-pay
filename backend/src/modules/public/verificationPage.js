'use strict';

const { DateTime } = require('luxon');

/**
 * The public verification page (§8, deliverable 5).
 *
 * Deliberately a single self contained HTML string with no framework, no build
 * step and no external requests: it is opened by someone standing at a Bursary
 * counter on a phone with a poor connection, and it must render instantly and
 * work offline of everything except this one response.
 *
 * The valid and invalid states are visually unmistakable — that is the entire
 * point of the page. A forged slip must not produce anything that could be
 * mistaken at a glance for a genuine one.
 */

const WAT = 'Africa/Lagos';

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const formatWat = (date) =>
  DateTime.fromJSDate(new Date(date)).setZone(WAT).toFormat("d LLLL yyyy 'at' HH:mm 'WAT'");

const REASON_TEXT = {
  malformed_code: 'That verification code is not in a valid format.',
  not_found: 'No receipt exists with that verification code.',
  signature_mismatch:
    'This receipt has been altered. Its signature does not match the record held by the University.',
  transaction_not_successful: 'The payment behind this receipt is not recorded as complete.',
};

function renderVerificationPage(result, submittedCode) {
  const valid = result.valid;
  const receipt = result.receipt;

  const rows = valid
    ? [
        ['Student', receipt.student_name],
        ['Matric number', receipt.matric_number],
        ['Fee item', receipt.fee_item],
        ['Amount paid', receipt.amount_formatted],
        ['Paid on', formatWat(receipt.paid_at || receipt.issued_at)],
        ['Receipt number', receipt.receipt_number],
        ['Payment reference', receipt.unn_reference],
      ]
    : [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${valid ? 'Valid receipt' : 'Receipt not valid'} · UNN Pay</title>
<style>
  :root {
    color-scheme: light;
    --ink: #111827;
    --muted: #6b7280;
    --line: #e5e7eb;
    --good: #0b6e4f;
    --good-bg: #f0fdf4;
    --bad: #b42318;
    --bad-bg: #fef3f2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #f9fafb;
    color: var(--ink);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    padding: 24px 16px 48px;
  }
  .wrap { max-width: 560px; margin: 0 auto; }
  header { text-align: center; margin-bottom: 20px; }
  header .uni { font-weight: 700; letter-spacing: .02em; font-size: 15px; }
  header .dept { color: var(--muted); font-size: 13px; }
  .card {
    background: #fff;
    border: 1px solid var(--line);
    border-radius: 12px;
    overflow: hidden;
    box-shadow: 0 1px 2px rgba(16,24,40,.06);
  }
  .status { padding: 24px 20px; text-align: center; }
  .status.valid { background: var(--good-bg); border-bottom: 1px solid #bbf7d0; }
  .status.invalid { background: var(--bad-bg); border-bottom: 1px solid #fecdca; }
  .mark {
    width: 56px; height: 56px; border-radius: 50%;
    display: grid; place-items: center; margin: 0 auto 12px;
    font-size: 30px; line-height: 1; color: #fff;
  }
  .valid .mark { background: var(--good); }
  .invalid .mark { background: var(--bad); }
  .status h1 { margin: 0 0 4px; font-size: 21px; }
  .valid h1 { color: var(--good); }
  .invalid h1 { color: var(--bad); }
  .status p { margin: 0; color: var(--muted); font-size: 14px; }
  dl { margin: 0; padding: 4px 20px 8px; }
  .row { display: flex; gap: 16px; padding: 13px 0; border-bottom: 1px solid var(--line); }
  .row:last-child { border-bottom: 0; }
  dt { flex: 0 0 42%; color: var(--muted); font-size: 13px; margin: 0; }
  dd { flex: 1; margin: 0; font-weight: 600; font-size: 14.5px; word-break: break-word; }
  .amount dd { color: var(--good); font-size: 17px; }
  .code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    letter-spacing: .06em;
  }
  footer { margin-top: 18px; color: var(--muted); font-size: 12.5px; text-align: center; }
  .lookup { margin-top: 20px; background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; }
  .lookup label { display:block; font-size:13px; color:var(--muted); margin-bottom:6px; }
  .lookup input {
    width:100%; padding:11px 12px; font-size:16px; border:1px solid var(--line);
    border-radius:8px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    text-transform: uppercase;
  }
  .lookup button {
    margin-top:10px; width:100%; padding:11px; font-size:15px; font-weight:600;
    color:#fff; background:var(--good); border:0; border-radius:8px; cursor:pointer;
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="uni">UNIVERSITY OF NIGERIA, NSUKKA</div>
    <div class="dept">Bursary Department · Receipt verification</div>
  </header>

  <div class="card">
    <div class="status ${valid ? 'valid' : 'invalid'}">
      <div class="mark">${valid ? '&check;' : '&times;'}</div>
      <h1>${valid ? 'Valid receipt' : 'Not a valid receipt'}</h1>
      <p>${
        valid
          ? 'This receipt was issued by the University and has not been altered.'
          : escapeHtml(REASON_TEXT[result.reason] || 'This receipt could not be verified.')
      }</p>
    </div>

    ${
      valid
        ? `<dl>${rows
            .map(
              ([label, value], index) => `
      <div class="row${index === 3 ? ' amount' : ''}">
        <dt>${escapeHtml(label)}</dt>
        <dd${index >= 5 ? ' class="code"' : ''}>${escapeHtml(value)}</dd>
      </div>`
            )
            .join('')}</dl>`
        : `<div style="padding:18px 20px;color:var(--muted);font-size:14px">
             <p style="margin:0 0 8px">Code checked: <span class="code">${escapeHtml(
               submittedCode
             )}</span></p>
             <p style="margin:0">If you were given this receipt as proof of payment, do not accept it.
             Ask the payer for a receipt issued through UNN Pay, or contact the Bursary.</p>
           </div>`
    }
  </div>

  <form class="lookup" method="GET" action="/verify" onsubmit="event.preventDefault();var v=this.code.value.trim();if(v)location.href='/verify/'+encodeURIComponent(v);">
    <label for="code">Check another receipt</label>
    <input id="code" name="code" placeholder="UNN-XXXX-XXXX" autocomplete="off" spellcheck="false">
    <button type="submit">Verify</button>
  </form>

  <footer>
    Verified against the University's own records at
    ${escapeHtml(formatWat(new Date()))}.
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderVerificationPage, escapeHtml, formatWat };
