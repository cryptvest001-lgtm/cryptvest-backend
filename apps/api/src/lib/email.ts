import { Resend } from "resend";
import { config } from "../config";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string;
  subject: string;
  html: string;
}) {
  if (!resend) {
    console.log(`[EMAIL] to=${to} subject=${subject}`);
    console.log(html);
    return { id: "mock" };
  }

  const result = await resend.emails.send({
    from: config.fromEmail,
    to,
    subject,
    html,
  });
  return result;
}

export async function sendVerificationEmail(email: string, token: string) {
  const url = `${config.webOrigin}/verify-email?token=${token}`;
  await sendEmail({
    to: email,
    subject: "Verify your Cryptvest email",
    html: `<p>Click the link to verify your email: <a href="${url}">${url}</a></p>`,
  });
}

export async function sendDepositCreditedEmail(
  email: string,
  amount: number,
  asset: string,
) {
  await sendEmail({
    to: email,
    subject: `Deposit received — ${amount.toFixed(8)} ${asset}`,
    html: `
      <h2>Deposit Confirmed</h2>
      <p>Your deposit of <strong>${amount.toFixed(8)} ${asset}</strong> has been confirmed and credited to your account.</p>
      <p><a href="${config.webOrigin}/dashboard">View your balance</a></p>
    `,
  });
}

export async function sendKycDecisionEmail(
  email: string,
  status: "APPROVED" | "REJECTED",
  reason?: string,
) {
  const approved = status === "APPROVED";
  await sendEmail({
    to: email,
    subject: approved ? "KYC Approved — You can now stake and withdraw" : "KYC Review Update",
    html: approved
      ? `<h2>Identity Verified</h2><p>Your KYC has been approved. You can now stake and request withdrawals.</p><p><a href="${config.webOrigin}/stake">Start staking</a></p>`
      : `<h2>KYC Not Approved</h2><p>Unfortunately your KYC submission was not approved.${reason ? ` Reason: ${reason}` : ""}</p><p>You may re-submit with updated documents.</p><p><a href="${config.webOrigin}/kyc">Re-submit KYC</a></p>`,
  });
}

export async function sendWithdrawalStatusEmail(
  email: string,
  status: "APPROVED" | "REJECTED" | "PAID",
  amount: number,
  asset: string,
  txHash?: string | null,
  reason?: string | null,
) {
  const labels: Record<string, string> = {
    APPROVED: "Withdrawal Approved",
    REJECTED: "Withdrawal Rejected",
    PAID: "Withdrawal Paid",
  };
  const body: Record<string, string> = {
    APPROVED: `Your withdrawal request for <strong>${amount.toFixed(8)} ${asset}</strong> has been approved and will be processed shortly.`,
    REJECTED: `Your withdrawal request for <strong>${amount.toFixed(8)} ${asset}</strong> was rejected.${reason ? ` Reason: ${reason}` : ""} Your balance has been restored.`,
    PAID: `Your withdrawal of <strong>${amount.toFixed(8)} ${asset}</strong> has been sent.${txHash ? ` TxHash: <code>${txHash}</code>` : ""}`,
  };
  await sendEmail({
    to: email,
    subject: labels[status] ?? "Withdrawal Update",
    html: `<h2>${labels[status]}</h2><p>${body[status]}</p><p><a href="${config.webOrigin}/activity">View activity</a></p>`,
  });
}
