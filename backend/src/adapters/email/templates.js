'use strict';

const { DateTime } = require('luxon');
const config = require('../../config');

/**
 * Email templates (§3.2).
 *
 * Plain, high contrast, no heavy imagery: many students read these on a low
 * bandwidth mobile connection, and an email that needs to load remote images to
 * be legible is an email that fails when it matters.
 *
 * OTP emails state the code as selectable text, not only inside a link, and
 * state the expiry time explicitly — both are specification requirements, and
 * both exist because a student whose email client strips links must still be
 * able to read their code.
 */

const WAT = 'Africa/Lagos';

const wat = (value) =>
  DateTime.fromJSDate(new Date(value)).setZone(WAT).toFormat("d LLL yyyy 'at' HH:mm 'WAT'");

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** One shell for every message, so they are consistent and each one is small. */
function shell({ heading, bodyHtml, footer }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden">
  <div style="background:#0B6E4F;padding:18px 22px">
    <div style="color:#ffffff;font-weight:700;font-size:15px;letter-spacing:.02em">UNIVERSITY OF NIGERIA, NSUKKA</div>
    <div style="color:#d1fae5;font-size:12.5px">Bursary Department &middot; UNN Pay</div>
  </div>
  <div style="padding:24px 22px">
    <h1 style="margin:0 0 14px;font-size:19px;line-height:1.3">${escape(heading)}</h1>
    ${bodyHtml}
  </div>
  <div style="padding:14px 22px;border-top:1px solid #e5e7eb;background:#fafafa;color:#6b7280;font-size:12px;line-height:1.5">
    ${footer || 'This is an automated message from UNN Pay. Please do not reply to it.'}
  </div>
</div>
</body></html>`;
}

/** The code, big and selectable, never only inside a link. */
const codeBlock = (code) =>
  `<div style="margin:18px 0;padding:16px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;text-align:center">
     <div style="font-size:12px;color:#6b7280;margin-bottom:6px">YOUR CODE</div>
     <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:.22em;color:#0B6E4F">${escape(
       code
     )}</div>
   </div>`;

function activationOtp({ full_name, matric_number, code, expires_at, expires_in_minutes }) {
  const link = `${config.PUBLIC_BASE_URL}/activate?matric=${encodeURIComponent(
    matric_number
  )}&code=${encodeURIComponent(code)}`;

  return {
    subject: 'Your UNN Pay activation code',
    html: shell({
      heading: 'Activate your UNN Pay account',
      bodyHtml: `
        <p style="margin:0 0 4px;font-size:14.5px">Hello ${escape(full_name)},</p>
        <p style="margin:0 0 4px;font-size:14.5px">Use this code to finish activating the UNN Pay account for matric number <strong>${escape(
          matric_number
        )}</strong>.</p>
        ${codeBlock(code)}
        <p style="margin:0 0 12px;font-size:14px">
          This code expires in <strong>${expires_in_minutes} minutes</strong>, at <strong>${wat(
            expires_at
          )}</strong>. It can be used once.
        </p>
        <p style="margin:0 0 12px;font-size:14px">
          You can also <a href="${escape(link)}" style="color:#0B6E4F">tap here to activate</a>.
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280">
          If you did not request this, ignore this email. Your account stays as it is.
        </p>`,
    }),
    text: [
      `Hello ${full_name},`,
      '',
      `Your UNN Pay activation code for ${matric_number} is: ${code}`,
      '',
      `It expires in ${expires_in_minutes} minutes, at ${wat(expires_at)}, and can be used once.`,
      '',
      `You can also activate here: ${link}`,
      '',
      'If you did not request this, ignore this email.',
    ].join('\n'),
  };
}

function passwordResetOtp({ full_name, code, expires_at, expires_in_minutes }) {
  const link = `${config.PUBLIC_BASE_URL}/reset-password?code=${encodeURIComponent(code)}`;
  return {
    subject: 'Your UNN Pay password reset code',
    html: shell({
      heading: 'Reset your UNN Pay password',
      bodyHtml: `
        <p style="margin:0 0 4px;font-size:14.5px">Hello ${escape(full_name)},</p>
        <p style="margin:0 0 4px;font-size:14.5px">Use this code to set a new password.</p>
        ${codeBlock(code)}
        <p style="margin:0 0 12px;font-size:14px">
          This code expires in <strong>${expires_in_minutes} minutes</strong>, at <strong>${wat(
            expires_at
          )}</strong>. It can be used once.
        </p>
        <p style="margin:0 0 12px;font-size:14px">
          You can also <a href="${escape(link)}" style="color:#0B6E4F">tap here to reset it</a>.
        </p>
        <p style="margin:0;font-size:13px;color:#6b7280">
          If you did not request a reset, ignore this email and your password stays unchanged.
        </p>`,
    }),
    text: [
      `Hello ${full_name},`,
      '',
      `Your UNN Pay password reset code is: ${code}`,
      '',
      `It expires in ${expires_in_minutes} minutes, at ${wat(expires_at)}, and can be used once.`,
      '',
      'If you did not request a reset, ignore this email.',
    ].join('\n'),
  };
}

const REASON_SENTENCE = {
  underpayment: 'the amount received was less than the amount due',
  overpayment: 'the amount received was more than the amount due',
  unknown_reference: 'the payment quoted a reference we do not recognise',
  expired_reference: 'the payment reference had already expired when the money arrived',
  duplicate_payment: 'this fee had already been paid',
};

function unappliedPaymentNotice({
  full_name,
  reason,
  amount_received,
  amount_expected,
  variance,
  deadline_at,
  unn_reference,
}) {
  const deadline = wat(deadline_at);
  const rows = [
    ['Amount received', `NGN ${amount_received}`],
    amount_expected ? ['Amount expected', `NGN ${amount_expected}`] : null,
    variance ? ['Difference', `NGN ${variance}`] : null,
    unn_reference ? ['Payment reference', unn_reference] : null,
  ].filter(Boolean);

  return {
    subject: 'Action needed: your UNN Pay payment could not be applied',
    html: shell({
      heading: 'Your payment needs attention',
      bodyHtml: `
        <p style="margin:0 0 10px;font-size:14.5px">Hello ${escape(full_name)},</p>
        <p style="margin:0 0 14px;font-size:14.5px">
          We received your payment, but it could not be applied to your fee because
          ${escape(REASON_SENTENCE[reason] || 'it did not match the expected payment')}.
          <strong>Your money has not been lost.</strong> It is being held and recorded against your record.
        </p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px;font-size:14px">
          ${rows
            .map(
              ([label, value]) =>
                `<tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #e5e7eb">${escape(
                  label
                )}</td><td style="padding:8px 0;text-align:right;font-weight:600;border-bottom:1px solid #e5e7eb">${escape(
                  value
                )}</td></tr>`
            )
            .join('')}
        </table>
        <div style="padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:14px">
          <strong>Please visit the Bursary before ${escape(deadline)}</strong>
          to have this resolved. Bring this email or your payment reference with you.
        </div>
        <p style="margin:14px 0 0;font-size:13px;color:#6b7280">
          No receipt is issued until the payment is applied, so this fee still shows as unpaid in the app.
        </p>`,
    }),
    text: [
      `Hello ${full_name},`,
      '',
      'We received your payment, but it could not be applied to your fee because ' +
        `${REASON_SENTENCE[reason] || 'it did not match the expected payment'}.`,
      'Your money has not been lost. It is being held and recorded against your record.',
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
      '',
      `Please visit the Bursary before ${deadline} to have this resolved.`,
      '',
      'No receipt is issued until the payment is applied.',
    ].join('\n'),
  };
}

function bursaryUnappliedAlert({
  reason,
  amount_received,
  amount_expected,
  variance,
  unn_reference,
  student_name,
  matric_number,
  deadline_at,
  unapplied_id,
}) {
  return {
    subject: `UNN Pay: unapplied payment #${unapplied_id} (${reason})`,
    html: shell({
      heading: 'An unapplied payment needs resolution',
      bodyHtml: `
        <p style="margin:0 0 12px;font-size:14.5px">
          A payment has been recorded that could not be applied automatically.
          It is now in the unapplied queue on the dashboard.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          ${[
            ['Item', `#${unapplied_id}`],
            ['Reason', reason],
            ['Student', student_name || 'Unknown'],
            ['Matric number', matric_number || 'Unknown'],
            ['Reference quoted', unn_reference || 'None'],
            ['Amount received', `NGN ${amount_received}`],
            ['Amount expected', amount_expected ? `NGN ${amount_expected}` : 'N/A'],
            ['Difference', variance ? `NGN ${variance}` : 'N/A'],
            ['Resolve before', wat(deadline_at)],
          ]
            .map(
              ([label, value]) =>
                `<tr><td style="padding:7px 0;color:#6b7280;border-bottom:1px solid #e5e7eb">${escape(
                  label
                )}</td><td style="padding:7px 0;text-align:right;font-weight:600;border-bottom:1px solid #e5e7eb">${escape(
                  value
                )}</td></tr>`
            )
            .join('')}
        </table>`,
      footer: 'Sent to the Bursary alert address configured for UNN Pay.',
    }),
    text: [
      'An unapplied payment needs resolution.',
      '',
      `Item: #${unapplied_id}`,
      `Reason: ${reason}`,
      `Student: ${student_name || 'Unknown'} (${matric_number || 'Unknown'})`,
      `Reference quoted: ${unn_reference || 'None'}`,
      `Amount received: NGN ${amount_received}`,
      `Amount expected: ${amount_expected ? `NGN ${amount_expected}` : 'N/A'}`,
      `Resolve before: ${wat(deadline_at)}`,
    ].join('\n'),
  };
}

function paymentSuccessful({ full_name, receipt_number, amount, fee_item_description, unn_reference }) {
  return {
    subject: `Payment received — receipt ${receipt_number}`,
    html: shell({
      heading: 'Your payment has been received',
      bodyHtml: `
        <p style="margin:0 0 10px;font-size:14.5px">Hello ${escape(full_name)},</p>
        <p style="margin:0 0 14px;font-size:14.5px">
          Your payment of <strong>NGN ${escape(amount)}</strong> for
          ${escape(fee_item_description)} has been received and applied in full.
        </p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:14px">
          ${[
            ['Receipt number', receipt_number],
            ['Payment reference', unn_reference],
          ]
            .map(
              ([label, value]) =>
                `<tr><td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #e5e7eb">${escape(
                  label
                )}</td><td style="padding:8px 0;text-align:right;font-weight:600;border-bottom:1px solid #e5e7eb">${escape(
                  value
                )}</td></tr>`
            )
            .join('')}
        </table>
        <p style="margin:0;font-size:14px">
          Your receipt is available in the UNN Pay app, and can be verified by anyone using the
          QR code or short code printed on it.
        </p>`,
    }),
    text: [
      `Hello ${full_name},`,
      '',
      `Your payment of NGN ${amount} for ${fee_item_description} has been received and applied in full.`,
      '',
      `Receipt number: ${receipt_number}`,
      `Payment reference: ${unn_reference}`,
      '',
      'Your receipt is available in the UNN Pay app.',
    ].join('\n'),
  };
}

module.exports = {
  activationOtp,
  passwordResetOtp,
  unappliedPaymentNotice,
  bursaryUnappliedAlert,
  paymentSuccessful,
  wat,
};
