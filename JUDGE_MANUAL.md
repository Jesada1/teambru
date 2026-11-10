# คู่มือการทดสอบระบบจัดตารางสอนอัตโนมัติ (Judge Demo Manual)

## 1. การเข้าใช้งานระบบสด (Live Cloud URL)
* **URL:** https://team-bru-seven.vercel.app (หรือ URL หลักของโครงการ)
* **Demo Mode:** ระบบเปิดใช้งาน **Judge Demo Mode** ไว้ที่แถบด้านบนสุด สามารถทดสอบสิทธิ์การใช้งานได้ 3 ระดับโดยไม่ต้องล็อกอิน:
  1. `[ฝ่ายวิชาการ (Academic Admin)]` — สิทธิ์จัดการตาราง รัน CSP Engine และสั่งงาน Agent
  2. `[อาจารย์ผู้สอน (Teacher)]` — สิทธิ์ดูตารางสอนรายบุคคลและอัปเดต คาบไม่ว่าง (Unavailable Slots)
  3. `[นักเรียน (Student)]` — สิทธิ์ดูตารางเรียนรายกลุ่มและตารางเรียนรายบุคคล

## 2. ขั้นตอนการทดสอบฟีเจอร์ไฮไลท์ (Core Features Showcase)
1. **การคำนวณ Zero Conflicts 100% (CSP Engine):**
   - กดปุ่ม "จัดตารางอัตโนมัติ" ระบบจะประมวลผลผ่าน CSP Engine ร่วมกับระบบ Early-Stop Optimization
   - สังเกตแท็กสถานะ **"Zero Conflicts (0)"** และค่า **Completion Rate (100%)**
2. **การสั่งงานภาษาธรรมชาติ (Agent Bar):**
   - พิมพ์สั่งในช่อง Agent Bar เช่น `"ครูสมชายลากิจคาบ 6"` หรือกดปุ่มทางลัด (Suggestion Chips)
   - ระบบจะประมวลผลแบบ **Plan → Act → Check** พร้อม Sandbox Draft State และ Auto-Rollback หากติดข้อขัดแย้ง
3. **การเปรียบเทียบประสิทธิภาพ (Algorithm Benchmark):**
   - ดูบล็อกเปรียบเทียบระหว่าง **CSP Engine vs Naive Greedy Algorithm** แสดงตัวเลขจริงของระยะเวลาประมวลผล (ms) และจำนวนข้อขัดแย้ง (Conflicts)
4. **การส่งออกเอกสาร (Native PDF):**
   - กดปุ่ม "ดาวน์โหลด PDF" เพื่อรับไฟล์ `Timetable_Schedule_2026.pdf` พร้อมหัวเอกสารทางการ