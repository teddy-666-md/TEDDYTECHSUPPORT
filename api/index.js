const express = require('express');
const cors = require('cors');
const axios = require('axios');
const nodemailer = require('nodemailer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');
const mongoose = require('mongoose');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== CONFIG - PUT YOUR KEYS HERE ==========
const CONFIG = {
    COMPANY_NAME: 'TEDDY-XMD Support',
    ADMIN_KEY: 'admin123', // change this
    
    // 1. MONGODB ATLAS - https://cloud.mongodb.com
    MONGO_URI: 'mongodb+srv://karmahell33_db_user:FdVaBDQOZj3qpCsn@cluster0.sjpgsqj.mongodb.net/?appName=Cluster0',
    
    // 2. TELEGRAM BOT - https://t.me/BotFather
    BOT_TOKEN: '8367642586:AAFHdGFNi1k8nYnhODr3efdM5EzCRLw38Mk',
    ADMIN_IDS: ['6815918612', '6815918612'], // your telegram user id
    
    // 3. OUTLOOK EMAIL
    OUTLOOK_EMAIL: 'teddyxmd@hotmail.com',
    OUTLOOK_PASS: 'Kibet44$$', // Use App Password
    
    // 4. GEMINI API KEY - https://aistudio.google.com/app/apikey
    GEMINI_API_KEY: 'AQ.Ab8RN6JuC9hyvl6fqtTNM15qT999pMVSMd2P34wd_5FzsatDYw', // <-- PUT YOUR GEMINI KEY HERE
};
// =========================================

const genAI = new GoogleGenerativeAI(CONFIG.GEMINI_API_KEY);

// MongoDB cache for Vercel
let cached = global.mongoose;
if (!cached) cached = global.mongoose = { conn: null, promise: null };
async function dbConnect() {
    if (cached.conn) return cached.conn;
    if (!cached.promise) cached.promise = mongoose.connect(CONFIG.MONGO_URI).then(m => m);
    cached.conn = await cached.promise;
    return cached.conn;
}

const ticketSchema = new mongoose.Schema({
    ticketID: String, name: String, email: String, message: String, 
    aiReply: String, status: { type: String, default: 'Open' },
    ip: String, createdAt: { type: Date, default: Date.now }
});
const Ticket = mongoose.models.Ticket || mongoose.model('Ticket', ticketSchema);

// Outlook SMTP
const transporter = nodemailer.createTransport({
    host: 'smtp.office365.com', port: 587, secure: false,
    auth: { user: CONFIG.OUTLOOK_EMAIL, pass: CONFIG.OUTLOOK_PASS }
});

async function generateTicketID() {
    await dbConnect();
    const count = await Ticket.countDocuments();
    return `TKT-${String(count + 1).padStart(4, '0')}`;
}

// GEMINI AI REPLY
async function generateAIReply(name, userMessage, ticketID) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `You are a professional support agent for ${CONFIG.COMPANY_NAME}. 
        Ticket ID: ${ticketID}. Reply in 3-4 sentences. Be helpful and kind. Always mention ticket ID.
        Customer Name: ${name}, Message: "${userMessage}". Sign off as ${CONFIG.COMPANY_NAME} Support Team.`;
        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (e) {
        console.log("Gemini Error:", e.message);
        return `Hi ${name},\n\nThanks for contacting ${CONFIG.COMPANY_NAME}! Your ticket ${ticketID} has been received. We will review "${userMessage}" and reply within 24 hours.\n\n${CONFIG.COMPANY_NAME}`;
    }
}

// API: CREATE TICKET
app.post('/api/support', async (req, res) => {
    await dbConnect();
    const { name, email, message } = req.body;
    if(!name || !email || !message) return res.json({success: false, error: 'All fields required'});
    try {
        const ticketID = await generateTicketID();
        const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
        const aiReply = await generateAIReply(name, message, ticketID);
        await new Ticket({ ticketID, name, email, message, aiReply, ip }).save();

        // Send Email from Outlook
        await transporter.sendMail({
            from: `"${CONFIG.COMPANY_NAME}" <${CONFIG.OUTLOOK_EMAIL}>`,
            to: email,
            subject: `[${ticketID}] We received your message - ${CONFIG.COMPANY_NAME}`,
            html: `<div style="font-family:Poppins,Arial;padding:20px;background:#f5f5f5"><div style="background:#fff;padding:25px;border-radius:15px;max-width:600px;margin:auto;border-top:4px solid #0078D4"><h2 style="color:#0078D4">Hi ${name},</h2><p><b>Ticket ID: ${ticketID}</b></p><p>Thanks for contacting <b>${CONFIG.COMPANY_NAME}</b>!</p><div style="background:#f9f9f9;padding:15px;border-left:4px solid #0078D4;margin:15px 0">${aiReply.replace(/\n/g, '<br>')}</div><p>Reply to this email and include ${ticketID} to continue the conversation.</p><hr><p style="font-size:12px;color:#888">${CONFIG.COMPANY_NAME} Support Team</p></div></div>`
        });

        // Telegram to Admins
        const adminText = `🚨 *NEW TICKET: ${ticketID}* 🚨\n\n👤 *Name:* \`${name}\`\n📧 *Email:* \`${email}\`\n📝 *Message:* ${message}\n\n*AI Reply:*\n${aiReply}`;
        for(let chatId of CONFIG.ADMIN_IDS){
            await axios.post(`https://api.telegram.org/bot${CONFIG.BOT_TOKEN}/sendMessage`, {
                chat_id: chatId, text: adminText, parse_mode: 'Markdown'
            }).catch(()=>{});
        }
        res.json({success: true, ticketID, aiReply});
    } catch(e) {
        console.error(e);
        res.json({success: false, error: e.message});
    }
});

// API: CLOSE TICKET
app.post('/api/close-ticket', async (req, res) => {
    await dbConnect();
    const { ticketID, key } = req.body;
    if(key !== CONFIG.ADMIN_KEY) return res.json({success: false, error: 'Unauthorized'});
    await Ticket.updateOne({ ticketID }, { status: 'Closed' });
    res.json({success: true});
});

// ADMIN DASHBOARD
app.get('/admin', async (req, res) => {
    await dbConnect();
    const key = req.query.key;
    if(key !== CONFIG.ADMIN_KEY) return res.status(403).send('<h1>403 Forbidden</h1><p>Use: /admin?key=admin123</p>');
    
    const tickets = await Ticket.find().sort({ createdAt: -1 });
    let rows = tickets.map(t => `
        <tr id="row-${t.ticketID}">
            <td><b>${t.ticketID}</b></td>
            <td>${t.name}</td>
            <td>${t.email}</td>
            <td><button onclick="showMsg('${t.ticketID}')" style="background:#0078D4;border:none;color:#fff;padding:5px 10px;border-radius:5px">View</button></td>
            <td>${new Date(t.createdAt).toLocaleString('en-GB')}</td>
            <td id="status-${t.ticketID}"><span style="padding:4px 10px;background:${t.status==='Open'?'#0078D4':'#25D366'};border-radius:5px">${t.status}</span></td>
            <td>${t.status === 'Open' ? `<button onclick="closeTicket('${t.ticketID}')" style="background:#ff4444;border:none;color:#fff;padding:6px 12px;border-radius:5px">Close</button>` : '-'}</td>
        </tr>
        <tr id="msg-${t.ticketID}" style="display:none;background:#1a1a1a"><td colspan="7"><b>Customer:</b><br>${t.message}<br><br><b>AI:</b><br>${t.aiReply}</td></tr>
    `).join('');

    res.send(`<!DOCTYPE html><html><head><title>Admin - ${CONFIG.COMPANY_NAME}</title>
    <style>body{font-family:Poppins;background:#0a0a0a;color:#fff;padding:20px}h1{color:#0078D4}table{width:100%;border-collapse:collapse;background:#111;border-radius:10px}th,td{padding:12px;border-bottom:1px solid #222}th{background:#0078D4}button{cursor:pointer}</style></head><body>
    <h1>📊 ${CONFIG.COMPANY_NAME} - Admin</h1><div>Total Tickets: ${tickets.length}</div><br>
    <table><tr><th>ID</th><th>Name</th><th>Email</th><th>Details</th><th>Time</th><th>Status</th><th>Action</th></tr>${rows || '<tr><td colspan=7>No tickets</td></tr>'}</table>
    <script>
    const ADMIN_KEY = '${CONFIG.ADMIN_KEY}';
    function showMsg(id){ const el = document.getElementById('msg-'+id); el.style.display = el.style.display === 'none' ? 'table-row' : 'none'; }
    async function closeTicket(id){
        if(!confirm('Close '+id+'?')) return;
        await fetch('/api/close-ticket', {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ticketID: id, key: ADMIN_KEY})});
        document.getElementById('status-'+id).innerHTML = '<span style="padding:4px 10px;background:#25D366;border-radius:5px">Closed</span>';
        document.getElementById('row-'+id).querySelector('td:last-child').innerHTML = '-';
    }
    </script></body></html>`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/support.html')));

module.exports = app;