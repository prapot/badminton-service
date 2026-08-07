# Badminton Service - Backend (Strapi)

## 📌 Project Overview
ระบบ Backend และ API สำหรับโปรเจกต์แบดมินตัน ทำหน้าที่จัดการฐานข้อมูล ผู้ใช้, แมตช์การแข่งขัน, ซีซั่น, และระบบ Ranking Points (RP)

## 🛠 Tech Stack
- **Framework:** Strapi v4 (Headless CMS)
- **Language:** Node.js, TypeScript
- **Database:** SQLite / PostgreSQL (ตามคอนฟิกของ Strapi)

## 📁 Architecture & Conventions
- **Entity Service API:** นิยมใช้ `strapi.entityService` ในการ Query ฐานข้อมูล (แทน Query Builder ปกติ)
- **Custom Controllers/Routes:**
  หากต้องการทำ Aggregation หรือ Business Logic ที่ซับซ้อน (เช่น ทำข้อมูล Analytics):
  1. สร้าง Route ใหม่ใน `src/api/<content-type>/routes/<custom-name>.ts`
  2. สร้างหรือ Extend Controller ใน `src/api/<content-type>/controllers/<content-type>.ts`
  3. จัดการ Data บน Server เพื่อลด Payload Size คืนให้ Frontend
- **Authentication:** ควบคุมด้วย Strapi Users & Permissions Plugin (JWT)

## 🤖 AI Assistant Rules (สำหรับ AI ทุกตัว)
1. **Data Processing:** พยายามย้าย Logic การคำนวณหรือจัดกลุ่มที่ซับซ้อนมาไว้ที่ Backend เสมอ (เช่น ระบบสรุปข้อมูลรายวัน/รายซีซั่น)
2. **Performance:** Query ให้อย่างมีประสิทธิภาพ เลือก `fields` และ `populate` เฉพาะที่จำเป็นเพื่อความรวดเร็วของ Response
3. **Types:** รักษาความถูกต้องของ TypeScript ใน Controller และ Services เสมอ
4. **Documentation Update:** ทุกครั้งที่คุณสร้าง Feature, Custom Route, หรือ Controller ใหม่ ให้ทำการอัปเดตสรุปฟีเจอร์เหล่านั้นลงในไฟล์ `project.md` นี้ (เช่นหัวข้อ `## 🆕 Recent Features`) เสมอ เพื่อให้ AI ตัวถัดไปทราบสถานการณ์ปัจจุบันของโปรเจกต์
