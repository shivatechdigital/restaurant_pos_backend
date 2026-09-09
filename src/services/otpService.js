const { query } = require('../config/db');

class OTPService {

    // 6-digit random OTP generate karo
    static generateOTP(length = 6) {
        let otp = '';
        for (let i = 0; i < length; i++) {
            otp += Math.floor(Math.random() * 10);
        }
        return otp;
    }

    // OTP generate karke database mein save karo
    static async sendOTP(phone, purpose = 'login') {
        const otp = this.generateOTP();
        const expiryMinutes = parseInt(process.env.OTP_EXPIRY_MINUTES) || 5;

        // Purane OTPs ko invalidate karo
        await query(
            `UPDATE otp_verifications SET is_used = TRUE 
             WHERE phone = $1 AND purpose = $2 AND is_used = FALSE`,
            [phone, purpose]
        );

        // Naya OTP save karo
        await query(
            `INSERT INTO otp_verifications (phone, otp, purpose, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '${expiryMinutes} minutes')`,
            [phone, otp, purpose]
        );

        // =============================================
        // REAL PROJECT MEIN YAHAN SMS BHEJO:
        // MSG91 / Twilio / Fast2SMS API call
        // Example:
        // await sendSMS(phone, `Your OTP is ${otp}. Valid for ${expiryMinutes} mins.`);
        // =============================================

        // Development ke liye console mein print karo
        console.log(`\n📱 OTP for ${phone} (${purpose}): ${otp}\n`);

        // otp yahan return kiya jata hai sirf testing/dev ke liye
        // (frontend isse tabhi dikhata hai jab debug_flags.dart mein kShowTestOtp = true ho)
        return { success: true, message: 'OTP sent successfully', otp };
    }

    // OTP verify karo
    static async verifyOTP(phone, otp, purpose = 'login') {
        const result = await query(
            `SELECT * FROM otp_verifications 
             WHERE phone = $1 AND otp = $2 AND purpose = $3 
             AND is_used = FALSE AND expires_at > NOW()
             ORDER BY created_at DESC LIMIT 1`,
            [phone, otp, purpose]
        );

        if (result.rows.length === 0) {
            return { success: false, message: 'Invalid or expired OTP' };
        }

        // OTP ko used mark karo (ek baar hi use ho)
        await query(
            `UPDATE otp_verifications SET is_used = TRUE WHERE id = $1`,
            [result.rows[0].id]
        );

        return { success: true, message: 'OTP verified successfully' };
    }
}

module.exports = OTPService;