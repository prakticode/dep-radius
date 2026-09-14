const nodemailer = require("nodemailer")

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
})

async function sendInvoice(customer, invoiceId) {
  await transporter.sendMail({
    from: "billing@example.com",
    to: customer.email,
    subject: `Invoice ${invoiceId}`,
    text: "Your invoice is attached.",
    attachments: [
      {
        filename: `invoice-${invoiceId}.pdf`,
        path: `${process.env.BILLING_SERVICE_URL}/invoices/${invoiceId}.pdf`,
      },
    ],
  })
}

module.exports = { sendInvoice }
