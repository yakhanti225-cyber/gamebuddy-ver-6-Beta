# คู่มือ GameBuddy: อัปโหลดขึ้น GitHub, ตั้งค่า Google login และ deploy บน Render

ทำตามลำดับจากบนลงล่าง ทีละขั้น

---

## ส่วนที่ 1: เตรียมไฟล์

ไฟล์ที่ต้องใช้มี 3 ไฟล์ และต้องวางให้ตรงโครงสร้างนี้

```
gamebuddy/
├── server.js        ← ไฟล์ใหม่ (ส่งมาให้แล้ว)
├── package.json     ← ไฟล์เดิมในโฟลเดอร์ ไม่ต้องแก้
└── public/
    └── index.html   ← ไฟล์ใหม่ (ส่งมาให้แล้ว) ต้องอยู่ในโฟลเดอร์ public/
```

สำคัญ: `index.html` ต้องอยู่ในโฟลเดอร์ `public/` เท่านั้น ถ้าวางไว้ข้างนอก หน้าเว็บจะไม่ขึ้น

---

## ส่วนที่ 2: อัปโหลดขึ้น GitHub

1. เปิด https://github.com/yakhanti225-cyber/gamebuddy
2. เข้าโฟลเดอร์ `gamebuddy/` (repo มีโฟลเดอร์นี้อยู่แล้ว)
3. เปิดไฟล์ `server.js` กดรูปดินสอ (Edit) ลบของเดิมทั้งหมด แล้ววางเนื้อหาไฟล์ใหม่ลงไป กด **Commit changes**
4. เข้าโฟลเดอร์ `public/` เปิด `index.html` กดรูปดินสอ ลบของเดิม วางไฟล์ใหม่ แล้ว **Commit changes**
5. ตรวจว่าโฟลเดอร์ `public/` มี `index.html` และ `gamebuddy/` มี `server.js` ครบ

ถ้าไม่สะดวกคัดลอกทีละไฟล์ ให้ใช้ปุ่ม **Add file → Upload files** ลากไฟล์ทับของเดิมได้เลย

---

## ส่วนที่ 3: ตั้งค่า Google login

### 3.1 สร้าง OAuth Client ใน Google Cloud

1. เข้า https://console.cloud.google.com แล้วสร้าง Project ใหม่ (หรือใช้ของเดิม)
2. ไปที่ **APIs & Services → OAuth consent screen** ตั้งชื่อแอป และอีเมลติดต่อ แล้วกด Save
3. ไปที่ **APIs & Services → Credentials → Create Credentials → OAuth client ID**
4. เลือก Application type เป็น **Web application**
5. ช่อง **Authorized redirect URIs** กด Add URI แล้วใส่:
   ```
   https://ชื่อเว็บของคุณ.onrender.com/api/auth/google/callback
   ```
   (ชื่อเว็บดูได้ในหน้า Render ตอนสร้างเสร็จ)
6. กด Create จะได้ **Client ID** และ **Client Secret** เก็บไว้ใช้ในส่วน 4

ข้อควรระวัง:
- URI ต้องตรงทุกตัวอักษร รวม `https://` และไม่มี `/` ท้าย
- ตอนนี้แอปอยู่ในโหมด Testing ถ้าให้คนอื่นล็อกอินได้ ต้องไปที่ **OAuth consent screen → Test users** แล้วเพิ่มอีเมลของคนนั้น หรือส่งขอ verify ก่อนเปิดให้ทุกคน

---

## ส่วนที่ 4: ตั้งค่า Environment บน Render

1. เปิดหน้า Service ของ GameBuddy บน Render
2. ไปที่แท็บ **Environment**
3. กด **Add Environment Variable** แล้วเพิ่มทีละตัว:

| ชื่อ (Key) | ค่า (Value) |
|---|---|
| `MONGODB_URI` | connection string จาก MongoDB Atlas |
| `ADMIN_PASSWORD` | รหัสผ่าน admin ที่คุณตั้งเอง (อย่างน้อย 6 ตัว) |
| `GOOGLE_CLIENT_ID` | Client ID จากส่วน 3 |
| `GOOGLE_CLIENT_SECRET` | Client Secret จากส่วน 3 |
| `PUBLIC_URL` | `https://ชื่อเว็บของคุณ.onrender.com` (ไม่มี `/` ท้าย) |

4. กด **Save Changes** Render จะ deploy ใหม่ให้เอง

หมายเหตุ:
- ถ้าไม่ได้ตั้ง `ADMIN_PASSWORD` ระบบจะสุ่มรหัสให้ และพิมพ์ออกใน Logs ครั้งเดียว ให้ไปดูใน Logs แล้วจดไว้
- ห้ามใส่รหัสผ่านหรือ Secret ลงในไฟล์โค้ดหรือส่งในแชทที่มีคนอื่นเห็น ถ้าเผลอส่งไปแล้วให้เปลี่ยนรหัสใหม่ทันที

---

## ส่วนที่ 5: ทดสอบ

1. เปิดเว็บ `https://ชื่อเว็บของคุณ.onrender.com`
2. กดปุ่ม **เข้าสู่ระบบด้วย Google** เลือกบัญชี Google ของคุณ
3. ถ้าสำเร็จจะเด้งกลับมาหน้า Home และเข้าสู่ระบบแล้ว
4. ลองเข้า admin ด้วยอีเมลหรือชื่อผู้ใช้ admin และรหัสจาก `ADMIN_PASSWORD`

---

## ส่วนที่ 6: ถ้าเกิดปัญหา

| ข้อความที่เห็น | สาเหตุที่พบบ่อย | วิธีแก้ |
|---|---|---|
| ยังไม่ได้ตั้งค่า Google login | ไม่ได้ใส่ `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` หรือ `PUBLIC_URL` | ตรวจส่วน 4 ให้ครบ แล้ว Save |
| `redirect_uri_mismatch` | redirect URI ใน Google ไม่ตรงกับเว็บจริง | แก้ URI ใน Google Cloud ให้ตรงกับส่วน 3 ข้อ 5 |
| `access_denied` หรือ 403 | บัญชีที่ล็อกอินไม่อยู่ในรายชื่อ Test users | เพิ่มอีเมลใน OAuth consent screen |
| เว็บขึ้นแต่ไม่มีหน้าตา | `index.html` ไม่ได้อยู่ในโฟลเดอร์ `public/` | ย้ายไฟล์ไป `public/` แล้ว commit ใหม่ |
| Render build ไม่ผ่าน | Root Directory ไม่ได้ตั้งเป็น `gamebuddy` | ไปที่ Settings ของ Render ตั้ง Root Directory เป็น `gamebuddy` |
| ต่อฐานข้อมูลไม่ได้ | `MONGODB_URI` ผิด หรือยังไม่ได้เปิดสิทธิ์ IP ใน Atlas | ตรวจ connection string และเปิด Network Access ใน Atlas (0.0.0.0/0 สำหรับทดลอง) |

ถ้าเจอข้อความอื่นนอกจากนี้ ให้คัดลอก error จาก Logs ของ Render ส่งมาได้เลย
