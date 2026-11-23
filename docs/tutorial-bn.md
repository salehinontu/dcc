# Drone Fleet — ব্যবহারের টিউটোরিয়াল (বাংলা)

এই টিউটোরিয়ালে আছে: নতুন Remote (controller) কীভাবে যোগ করবেন, drone কীভাবে চালু হয়,
আর রোজকার সব কাজ কীভাবে করবেন। বাটন আর মেনুর নাম ইংরেজিতেই রাখা হয়েছে, কারণ
screen-এ ঠিক ওই নামই দেখবেন।

সাইট: **https://fleet.example.com**

---

## ১. আগে বুঝে নিন: তিনটা জিনিস কীভাবে জোড়া লাগে

```
  Drone  ──(DJI-র নিজের সংযোগ)──►  Remote (RC Plus 2)  ──(internet)──►  Drone Fleet সার্ভার  ──►  আপনার dashboard
```

- Drone সরাসরি আমাদের সার্ভারের সাথে কথা বলে না। **Remote-টাই** drone-এর হয়ে সব পাঠায়।
- তাই **প্রতিটা drone-এর জন্য একটা Remote** লাগে। আর Remote-এ আমাদের page দিয়ে একবার connect করে
  সেটা **চালু রাখতে হয়** (বন্ধ করা বা ছেড়ে যাওয়া চলবে না; বিস্তারিত ধাপ ২-এর শেষে)।
- প্রতিটা নতুন Remote **একবার admin-এর অনুমতি (Approve)** পায়। অনুমতি পেলে সেটা স্থায়ী।
  এটা ইচ্ছা করেই manual, যাতে অন্য কেউ নিজেকে আপনার drone-এর Remote সাজাতে না পারে।

### চার রকম account

| Account | কে ব্যবহার করে | কী করতে পারে |
| --- | --- | --- |
| **Developer** | আপনারা (software যারা বানিয়েছেন/বিক্রি করেন) | সব কিছু। শুধু Developer-ই **Admin** বানাতে পারে। server-এর CLI দিয়ে বানানো হয় |
| **Admin** | যে প্রতিষ্ঠান software চালায় তার প্রধান | সব feature: account বানানো, Remote approve, zone আঁকা, drone-এর নাম/রং। **Sub-admin** আর **Drone operator** বানাতে পারে |
| **Sub-admin** | অফিসের অন্য লোক | Admin যা অনুমতি দেবে, ঠিক ততটুকু (সব drone বা বাছাই করা drone)। Admin চাইলে সব অধিকার দিতে পারে, "Manage users" সহ |
| **Drone operator** | যিনি Remote-এ ঢোকেন | শুধু Remote সাইটে sign in করানো। এই account দিয়েই Remote যোগ হয় |

> ⚠️ শুধু **Drone operator** role-এর account দিয়ে Remote-এ ঢোকা যায়। Dashboard-এ pilot-এর আলাদা কিছু
> (ছবি, পদবি) দেখায় না। Map-এ শুধু drone-এর নাম, নিজের রঙে।

---

## ২. নতুন Remote যোগ করা (পুরো ধাপ)

প্রতিটা নতুন Remote-এ একই কাজ। দুইজন লাগে: **আপনি (Admin, কম্পিউটারে)** আর **drone operator (Remote-এ)**।
আপনি একাই দুই কাজ করলেও চলে।

### শুরুর আগে চেক করুন

- Remote-এ internet আছে।
- Remote চালু করে DJI-র নিজের setup শেষ করা আছে (DJI account দিয়ে login, certificate)।
- Pilot-এর জন্য আপনি Drone Fleet-তে একটা **Drone operator account** বানিয়েছেন (নিচে ধাপ ১)।

### ধাপ ১ — Admin: Pilot-এর login বানান

🖥️ কম্পিউটারে, Admin হিসেবে

1. https://fleet.example.com-এ sign in করুন।
2. বাঁ দিকে **Drones** খুলুন, তারপর **Add video-only drone**-এর পাশের **Add drone operator** চাপুন।
3. **Email** দিন (pilot-এর নিজের email হলে ভালো)।
4. **Password** দিন (কমপক্ষে ৮ অক্ষর) অথবা **Generate** চেপে **Copy** করুন।
5. Pilot-এর কোনো permission বাছতে হয় না। Drone operator শুধু Remote connect করার জন্য, তার যা লাগে
   (সব drone দেখা আর bind করা) সেটা নিজে থেকেই পায়।
6. **Create** চাপুন। Email আর password pilot-কে নিরাপদে জানান। এই password দিয়েই সরাসরি Remote-এ ঢোকা যায়।

### ধাপ ২ — (ইচ্ছা হলে) Drone operator নিজের password বদলাতে পারেন

💻 কম্পিউটার বা ফোনে

এটা **বাধ্যতামূলক নয়**। Admin যে password দিয়েছে, সেটা দিয়েই Remote-এ ঢোকা যায়। নিজের পছন্দের password চাইলে:

1. https://fleet.example.com খুলে email আর password দিয়ে sign in করুন।
2. বাঁ panel-এর নিচে তালা (🔒) চাপুন, এখনকার password আর নতুন password (কমপক্ষে ৮ অক্ষর) দিন।
3. **Change password** চাপুন। এরপর নতুন password-ই Remote-এ চলবে।

### ধাপ ৩ — Remote-এ সাইটের address বসান (প্রতিটা নতুন Remote-এ একবার)

📱 Remote-এ (RC Plus 2)

1. **DJI Pilot 2** খুলুন।
2. **Cloud Services** খুলুন। কিছু Pilot 2 version-এ এর নাম **Cloud Platform**।
3. সেখানে third-party / other platform-এর address ঘরে লিখুন:

   ```
   https://fleet.example.com/pilot
   ```

4. Entry-টার নাম দিন **Drone Fleet**, save করুন।

> ℹ️ Menu-র ঠিক নাম Pilot 2-এর version অনুযায়ী একটু আলাদা হতে পারে। আমি এই অংশ আসল RC Plus 2-তে
> এখনো পরীক্ষা করিনি। না মিললে `docs/hardware-bring-up.md` দেখুন বা কী দেখছেন জানান।

পরের বার থেকে Remote-এ শুধু **Cloud Services → Drone Fleet** চাপলেই page খোলে।

### ধাপ ৪ — Drone operator: Remote-এ sign in

📱 Remote-এ

1. **Cloud Services → Drone Fleet** খুলুন। "Connect this controller" card আসবে।
2. **Email** আর **Password** দিন (Admin যা দিয়েছে, বা ধাপ ২-এ আপনি যা বদলেছেন)।
3. **Connect controller** চাপুন।

Page নিজেই DJI licence যাচাই করে, Remote-এর serial নম্বর পড়ে, আর সার্ভারকে জানায়।

### ধাপ ৫ — Remote অপেক্ষা করবে ("Awaiting approval")

📱 Remote-এ — কিছু করার নেই

Card-এ **Awaiting approval** আর নিচে Remote-এর serial দেখাবে। এটাই স্বাভাবিক। এখনো কিছু পাঠানো হচ্ছে না।
**Page খোলা রাখুন।**

### ধাপ ৬ — Admin: Approve করুন

🖥️ কম্পিউটারে, Admin হিসেবে

**দ্রুত উপায়:** বাঁ panel-এ **Awaiting approval** বক্স দেখাবে, তাতে Remote-এর serial আছে।
**✓ (tick)** চাপলে অনুমতি, **✗ (cross)** চাপলে প্রত্যাখ্যান।

**বিস্তারিত উপায়:** **Controllers and drones** → **Controllers** tab → serial খুঁজুন (অবস্থা: pending)
→ **Approve**।

> ⚠️ কিছু না দেখলে বুঝুন drone operator **Connect controller** চাপেনি। চাপার আগে list-এ কিছু আসে না।

### ধাপ ৭ — Drone operator: Approval চেক

📱 Remote-এ

1. **Check approval** চাপুন।
2. সাতটা ধাপ একে একে সবুজ হবে: Account sign-in → DJI licence → Controller approval → Cloud API module →
   Telemetry link → Workspace → Live video service।
3. শেষে card বদলে **Controller connected** হবে।

প্রায় ১০ সেকেন্ডের মধ্যে dashboard-এর map-এ drone চলে আসে। 🎉

### ধাপ ৮ — Admin: drone-কে নাম, label আর রং দিন

🖥️ কম্পিউটারে

1. **Drones** খুলুন।
2. Drone-এর নাম বদলান (যেমন *Drone 1*): নামের ঘরে লিখে **Enter**।
3. চাইলে **Label** ঘরে একটা ডাকনাম লিখে **Enter** দিন (যেমন *Fire-1*)। ওটা নামের পাশে `Drone 1 · Fire-1` হয়ে map, বাঁ পাশের তালিকা,
   live wall, flight আর alert-এ দেখায়, আর search-এও খুঁজে পাওয়া যায়। ঘর খালি করলে label মুছে যায়।
4. রং বেছে নিন। Map-এ drone-এর নাম এই রঙের ছোট লেবেলে সবসময় দেখায়। flight path আর trail-ও এই রঙে।
   লাল রং দেওয়া হয় না, কারণ লাল মানে no-fly zone।

### ধাপ ৯ — উড়ানের সময়

- Connect হয়ে গেলে Remote-এর **Drone Fleet page বন্ধ করবেন না** (page থেকে বেরিয়ে যাবেন না, app বন্ধ করবেন না)
  এবং Remote-এর **screen যেন ঘুমিয়ে না যায়**। Page ছাড়লে বা screen ঘুমালে drone **Offline** দেখাতে পারে।
- Take-off করলে flight নিজে থেকে record হয়। কিছু চাপতে হয় না।

**প্রথম উড়ানের আগে একটা পরীক্ষা করে নিন** (মাটিতে বসে, ২ মিনিট):

1. Remote connect করে সাতটা ধাপ সবুজ করুন। dashboard-এ drone **Online** দেখুন।
2. Pilot 2-তে নিজের মতো **flight view (camera screen)**-এ চলে যান। Drone Fleet page পেছনে থাকবে।
3. ৩০ সেকেন্ড পর dashboard দেখুন। drone **Online** থাকলে: পেছনে থাকা page-ই যথেষ্ট, উড়ানে flight view-তেই থাকতে পারেন।
   **Offline** হয়ে গেলে: page-টা সামনে খোলা রেখেই উড়াতে হবে (অথবা কোন ধাপে কাটছে আমাকে জানান)।

DJI-র নিয়ম হয়তো Remote ভেদে আলাদা। তাই এই উত্তরটা আপনার নিজের Remote-ই বলে দেবে।

---

## ৩. ৪টা বা ৮টা drone: একই কাজ বারবার

প্রতিটা drone, প্রতিটা Remote, প্রতিটা pilot-এর জন্য **ধাপ ১ থেকে ৮** আলাদাভাবে করুন।

| কাজ | কয়বার |
| --- | --- |
| Pilot-এর login বানানো (ধাপ ১) | প্রতি pilot-এ একবার |
| Remote-এ address বসানো (ধাপ ৩) | প্রতি Remote-এ একবার |
| Approve (ধাপ ৬) | প্রতি Remote-এ একবার |
| Drone-এর নাম, রং (ধাপ ৮) | প্রতি drone-এ একবার |

- Software-এ drone operator বা drone সংখ্যার কোনো সীমা নেই।
- Server এখন ছোট (২ vCPU)। ৮টা drone-এর position আর map সহজে চলবে। কিন্তু **৮টা live video একসাথে** চালানো
  আমি পরীক্ষা করিনি। ৮টা হলে server বড় করা ভালো।

---

## ৪. রোজকার কাজ

### Operations map (হোম)

- বাঁ দিকের list থেকে drone-এ click করলে map সেখানে যায়, নিচে card খোলে: উচ্চতা, speed, battery, heading।
- প্রতিটা drone-এর নিজের রং, আর map-এ তার নাম সেই রঙের লেবেলে।
- **No-fly zones** আর **Geofences** চালু/বন্ধ করা যায় (map-এর উপরের বাঁ দিকে)।
- Drone **Offline** হলে বিন্দুর ভেতর ফাঁকা হয়ে যায়। "LAST KNOWN" লেখা সংখ্যাগুলো পুরনো, লাইভ নয়।

### Live wall ও video

1. **Live wall** চাপুন: প্রতিটা online drone-এর একটা tile।
2. Tile-এ click করলে পুরো screen।
3. **Capture** = ছবি তুলে সার্ভারে রাখা। **Quality** = video-র মান।
4. Video না এলে: drone Online কিনা দেখুন → ১০ সেকেন্ড অপেক্ষা → **Back** দিয়ে আবার খুলুন → **Quality** কমান।

### Video record করা (আপনার laptop-এ)

Recording আপনার **laptop-এ** save হয়, server-এ নয়। সব কাজ laptop করে, তাই server-এর ওপর কোনো চাপ পড়ে না।

1. **Live wall**-এ কোনো drone-এর tile-এর ওপর mouse রাখুন। নিচে **● REC** button আসবে।
2. Click করুন। **প্রথমবার** browser জিজ্ঞেস করবে কোন folder-এ রাখবে। একটা folder বেছে নিন (যেমন *Fleet recordings*)। পরে কোনোদিন আবার **Allow** চাইতে পারে, Allow দিন।
3. Button লাল হয়ে সময় দেখাবে: **● 2:15 ■**। Wall-এর ওপরেও drone-এর নাম আর সময় দেখাবে।
4. বন্ধ করতে লাল button-এ আবার click করুন (বা wall-এর ওপরের নামে)। **Recording saved** লেখা আসবে, সাথে file-এর নাম।

- ৪টা drone একসাথে record করা যায়। প্রতিটার আলাদা file হয়।
- Full screen-এ গেলে, layout বদলালে বা অন্য screen-এ গেলেও recording চলতে থাকে। Full screen-এ **Record** button-ও আছে।
- File-এর নাম: **DRONE-FLEET\_drone-এর নাম\_তারিখ\_সময়.mp4**, যেমন `DRONE-FLEET_Drone-2_2026-10-29_19-11-46.mp4`।
- Folder বদলাতে wall-এর ওপরে **Recordings: …** চাপুন।
- **Stop না চাপা পর্যন্ত tab বন্ধ করবেন না।** বন্ধ করলে চলতে থাকা অংশটা হারাবে। Page ছাড়তে গেলে browser সতর্ক করবে।
- Video কেটে গিয়ে আবার এলে recording নতুন file-এ চলতে থাকে, নতুন সময়ের নামে। লম্বা recording প্রতি **৩০ মিনিটে** নতুন file-এ ভাগ হয়।
- শুধু ছবি, শব্দ নেই। প্রতি drone-এ ঘণ্টায় মোটামুটি **২ GB** লাগে।
- Recording চলার সময় folder-এ **.crswap** শেষ হওয়া একটা file দেখতে পারেন। Stop চাপলে সেটা .mp4 হয়ে যায়।
- Chrome বা Edge ব্যবহার করুন। Safari/Firefox-এ file সরাসরি **Downloads** folder-এ যায়।

### Screenshots আর মানুষ গোনা

1. **Screenshots**-এ সব ছবি। drone বা তারিখ দিয়ে ছাঁটাই করুন।
2. ছবি খুলে **People** চাপলে AI মানুষ গোনে (বড় ছবিতে ১০–২০ সেকেন্ড)।
3. AI-র সংখ্যা **অনুমান**। নিজে দেখে ঠিক করে **Save** দিলে সেটাই চূড়ান্ত (verified) সংখ্যা। রিপোর্টে verified সংখ্যাই দিন।
4. **মুছতে:** ছবির নিচের **trash** আইকন, অথবা ছবি খুলে **Delete**। অনেকগুলো একসঙ্গে মুছতে উপরের **Select** চেপে টিক দিন, তারপর **Delete selected**। প্রতিবার জিজ্ঞেস করে, আর একবার মুছলে আর ফেরে না (ছবি আর মানুষ-গোনা দুটোই যায়)।
   এর জন্য account-এ **Delete screenshots** অধিকার লাগে। Admin-এর আগে থেকেই আছে, অন্যদের দিতে হলে **Users and permissions**-এ টিক দিন।

### No-fly zone আর Geofence

**Zones and geofences** খুলুন। সবাই দেখতে পায়, শুধু অনুমতি থাকলে আঁকা যায়।

- আগে থেকে ৪২টা red no-fly zone আছে (airport, সেনা এলাকা, সরকারি স্থাপনা)। **এগুলো আনুমানিক**, সরকারি
  অনুমতির বিকল্প নয়। উড়ার আগে CAAB বা সংশ্লিষ্ট কর্তৃপক্ষের অনুমতি নিন।
- **নিজে আঁকা:** উপরে ডানে **No-fly zone** বা **Geofence** চাপুন।
  - **Circle:** map-এ একবার click, তারপর গোল handle টেনে সরান, চৌকো handle টেনে বড়-ছোট করুন (বা radius সংখ্যায় লিখুন)।
  - **Polygon:** **Polygon** চেপে প্রতিটা কোণায় click। প্রথম বিন্দুতে click বা **Enter** দিলে আকৃতি বন্ধ হয়।
  - পরে কোণা টেনে সরান, দুই কোণার মাঝের ছোট বিন্দুতে click করে কোণা বাড়ান, কোণায় double-click করে মুছুন।
- **Warning distance** (শুধু no-fly): zone-এর কিনারার কত মিটার আগে সতর্কবার্তা আসবে। প্রতিটা zone-এর জন্য আলাদা
  করে সংরক্ষিত হয়। ডিফল্ট: airport ৩ কিমি, সেনা ৬০০ মি, সরকারি ৫০০ মি।
- **Geofence:** drone এই এলাকার **বাইরে** গেলে alert। সব drone বা বেছে নেওয়া drone-এর জন্য দেওয়া যায়।
- **Active** বন্ধ রাখলে zone থাকে কিন্তু alert আসে না।

### Alerts

যে drone **উড়ছে** (২ মিটারের বেশি উচ্চতায়) সে no-fly zone-এর কাছে গেলে, ভেতরে ঢুকলে বা geofence ছাড়লে:
উপরে ডানে বক্স আসে আর beep হয়, বাঁ মেনুর **Alerts**-এ লাল সংখ্যা, map-এ drone লাল ঘেরে ঝলকায়।

- **Show on map** = drone-এ যাওয়া। **Acknowledge** = "দেখেছি" বলা।
- Drone সরে গেলে বা নামলে alert নিজে বন্ধ হয়।
- মাটিতে বসে থাকা drone চুপ থাকে।
- **Contact lost:** উড়ন্ত drone controller থেকে সংযোগ হারালে বা প্রায় ৪৫ সেকেন্ড কোনো তথ্য না পাঠালে alert আসে।
  শেষ position, উচ্চতা আর battery alert-এ লেখা থাকে। drone আবার সাড়া না দেওয়া পর্যন্ত alert খোলা থাকে।
  নেমে গিয়ে বন্ধ করা drone-এ এই alert আসে না।
- **Low battery:** উড়ন্ত drone-এর battery ৩০%-এ নামলে সতর্কতা, ১৫%-এ (বা drone নিজে ২ মিনিটের কম উড়ার সময় বললে) critical alert।
  উড়ান শেষ হলে এই alert বন্ধ হয়। সংখ্যাগুলো সার্ভারের দায়িত্বে যিনি, তিনি বদলাতে পারেন।
- Alert **শুধু dashboard-এ** আসে। SMS বা email আসে না।

### Flight history

**Flight history** খুলুন। প্রতি সারিতে: কখন শুরু, কোন drone, সময়, দূরত্ব, সর্বোচ্চ উচ্চতা, speed, battery, alert সংখ্যা।
Drone বা তারিখ দিয়ে ছাঁটাই করা যায়।

একটা flight-এ click করলে:

- map-এ **পুরো path** (drone-এর রঙে), **তীর** দিয়ে কোন দিকে গেছে, **S** = take-off, **E** = landing, লাল **!** = যেখানে alert হয়েছে।
- উচ্চতা, speed, battery, মোট দূরত্ব, take-off থেকে সবচেয়ে দূরের বিন্দু।
- **Replay**: 1×, 5×, 20×, 60× গতিতে drone-এর উড়ান আবার দেখুন। slider বা height/speed chart টেনে যেকোনো মুহূর্তে যান।

---

## ৪ক. DJI Mini-র মতো drone: শুধু video (Remote ছাড়া)

DJI Mini 5 Pro-র মতো ছোট drone Pilot 2 বা Remote-এর মধ্য দিয়ে যায় না, তাই map-এ অবস্থান, ব্যাটারি বা flight history আসে না। কিন্তু **video** live wall-এ আনা যায়।

1. 🖥️ Admin: **Drones** → **Add video-only drone** → নাম লিখুন (যেমন *Mini 5 Pro*) → **Create**।
2. একটা পাতা খুলবে, তাতে তিনটা ঘর আর প্রতিটার পাশে **Copy**: **RTMP Address**, **Stream Key**, আর দুটো জোড়া দেওয়া পুরো address।
3. 📱 DJI Fly-তে (Mini-র Remote থেকে) **Livestream** → RTMP: **RTMP Address** ঘরে প্রথমটা, **Stream Key** ঘরে দ্বিতীয়টা বসান। (চাইলে পুরো address শুধু RTMP Address ঘরে দিয়ে Stream Key ফাঁকা রাখুন।)
4. **Resolution 720P**, আর upload ভালো না হলে **Smooth** রাখুন। তারপর **Start Livestream**।
5. কয়েক সেকেন্ডে live wall-এ ওই নামের tile আসবে, বাঁ list-এ **Video only · streaming**। DJI Fly-তে থামালে tile Offline হয়, আবার শুরু করলে নিজে ফেরে।

যা পাবেন: ছবি, বড় করে দেখা, screenshot, people count, recording। যা পাবেন না: অবস্থান, ব্যাটারি, উচ্চতা, flight history, zone alert। Start/Stop আর quality শুধু DJI Fly থেকে।

⚠️ ওই address একটা password-এর মতো। কারো হাতে গেলে **Drones → Address → Make a new key** চাপুন, পুরোনোটা সঙ্গে সঙ্গে বন্ধ। মুছতে **Remove**।

---

## ৫. Remote বা drone বদলানো

### Remote বদলানো (drone একই, নতুন Remote)

নতুন Remote শুরুতে প্রত্যাখ্যাত হবে ("এই drone অন্য Remote-এর")। এটা নিরাপত্তার জন্য।

1. 🖥️ Admin: **Controllers and drones** → **Controllers** → **পুরনো** Remote-এর **Unbind** → নিশ্চিত করুন।
   ⚠️ উড়ানের মাঝে করবেন না, ওই Remote-এর সব drone রিপোর্ট বন্ধ করে।
2. 📱 নতুন Remote-এ **ধাপ ৩ থেকে ৭** করুন (address, sign in, approve, check)।

### Drone সাময়িক বন্ধ রাখা

**Controllers and drones → Drones → Disable**। Map, wall আর search থেকে সরে যায়, video বন্ধ, ইতিহাস থাকে।
**Enable** চাপলেই ফেরে।

### Drone স্থায়ীভাবে বাদ

বাঁ list-এ drone-এর উপর hover করে **trash** আইকন → নিশ্চিত করুন। ⚠️ এটা কেবল ওই drone-এর **নিজের Remote** থেকে ফেরানো যায়।
সন্দেহ থাকলে **Disable** করুন, Delete নয়।

---

## ৬. Account আর password

- **নিজের email (sign-in ID) বদল:** বাঁ panel-এর নিচে তালা (🔒) আইকন → **Your sign-in email** → নতুন email আর এখনকার password দিয়ে **Change email**।
  এরপর নতুন email দিয়ে ঢুকতে হয়, পুরোনোটা আর চলে না। কাউকে sign out করে না, Remote-ও কাটে না। সব role পারে।
- **নিজের password বদল:** একই পাতার নিচে **Change password**।
- **নতুন version এলে:** খোলা পাতার নিচে "A new version of … is ready" বার্তা আর **Reload** বোতাম আসে। Recording চলার সময় না চেপে, শেষ করে চাপুন।
- **অন্যের password reset:** **Users and permissions** → ওই account → **Edit** → নতুন password → **Save**। নতুন password সঙ্গে সঙ্গে কাজ করে, আলাদা কিছু বদলাতে হয় না।
  ⚠️ এতে তার সব session শেষ হয়। তার drone উড়ছে থাকলে সেটা রিপোর্ট বন্ধ করবে। **উড়ানের মাঝে করবেন না।**
- **Account বন্ধ করা:** **Users and permissions**-এ ওই account-এর সারিতে **Disable** চাপুন। আবার চালু করতে **Enable**।
- **কে কার account দেখে:** প্রতিটা Admin আলাদা প্রতিষ্ঠানের মতো (যেমন Fire Service, Police)। Admin (আর তার Sub-admin)
  শুধু নিজের বানানো Sub-admin আর Drone operator দেখে, অন্য Admin-এর গুলো দেখে না, ছুঁতেও পারে না। Developer সবাইকে দেখে, প্রতিটা Admin-এর
  নিচে তার Sub-admin আর Drone operator কয়টা (আর কে বানিয়েছে) সহ। Developer নতুন Sub-admin বা Drone operator বানালে **Belongs to Admin**-এ বেছে দেয়
  কোন Admin-এর। ⚠️ এখন শুধু account আলাদা; drone, Remote, screenshot, zone সব Admin-এর কাছে একই।
- **Account মুছে ফেলা:** একই সারিতে **Delete** চাপুন ও নিশ্চিত করুন। এটা চিরতরে মোছে, ফেরানো যায় না। তার session শেষ হয়, আর
  Drone operator account হলে তার Remote সংযোগ হারায় (অন্য Drone operator account দিয়ে ঢুকলে আবার চলবে)। ফিরিয়ে আনার সম্ভাবনা থাকলে মোছার বদলে **Disable** করুন।
  নিজের account বা Developer-কে মোছা যায় না, আর Admin-কে শুধু Developer মুছতে পারে।
- **নিজের password:** **Users and permissions**-এ নিজের সারিতে **Change password** বোতামও আছে।
- **অফিসের কর্মীর account** (দেখার জন্য): Role **Sub-admin**, তারপর কোন drone আর কী কী দেখতে পারবে বেছে দিন
  (**Flights**-এ tick দিলে flight history দেখবে)।
- Sign in থাকে ১২ ঘণ্টা। Sign out হলে আবার ঢুকুন।

---

## ৭. সমস্যা হলে

### কম্পিউটারে

| কী দেখছেন | মানে | কী করবেন |
| --- | --- | --- |
| "Invalid credentials" | email বা password ভুল | বড়-ছোট হাতের অক্ষর, চিহ্ন দেখুন। Admin reset করে দিতে পারে |
| Map ফাঁকা, drone নেই | কেউ রিপোর্ট করছে না | Remote চালু ও page খোলা কিনা দেখুন |
| Drone ধূসর, "Offline" | রিপোর্ট বন্ধ | Remote-এ Drone Fleet page খোলা ও internet আছে কিনা দেখুন |
| Video আসছে না | stream শুরু হয়নি | ১০ সেকেন্ড অপেক্ষা, আবার খুলুন, Quality কমান |
| "Reconnecting" | আপনার কম্পিউটার সার্ভার হারিয়েছে | internet দেখুন, নিজে ফিরে আসে |
| হঠাৎ sign-in পাতায় ফিরে গেল | ১২ ঘণ্টা পার হয়েছে বা admin আপনার account বদলেছে | আবার sign in করুন |
| পুরনো পাতা দেখাচ্ছে | browser পুরনো কপি ধরে রেখেছে | Cmd+Shift+R (Windows-এ Ctrl+Shift+R) |

### Remote-এ

| কী দেখছেন | মানে | কী করবেন |
| --- | --- | --- |
| "Email or password is incorrect" | login ভুল | নতুন password দিয়েছেন তো? Admin reset করতে পারে |
| "This account cannot bind a controller" | account-টা Drone operator নয় | **Drone operator** role-এর account ব্যবহার করুন |
| "Drone binding permission required" | পুরোনো Drone operator account-এ অধিকার ঠিক ছিল না | Admin ওই account **Edit** করে একবার **Save** করুন; Pilot-এর অধিকার নিজে থেকে ঠিক হয়ে যায় |
| **Awaiting approval** | admin approve করেনি | Admin-কে বলুন, তারপর **Check approval** |
| **Controller not approved** | admin প্রত্যাখ্যান করেছে | Admin কেন করল জানুন, Controllers-এ **Approve** |
| **Licence verification failed** | সার্ভারের DJI App ID / Key / Licence-এ সমস্যা | এটা Remote-এর দোষ নয়। সার্ভার যিনি দেখেন তাঁকে জানান |
| সবুজ ধাপ কিন্তু drone map-এ নেই | Remote সার্ভারে পৌঁছাচ্ছে না | Remote-এর internet দেখুন |
| "Too many requests" | অল্প সময়ে অনেকবার চেষ্টা | এক মিনিট থেমে আবার |
| উড়ানের মাঝে Offline | page বন্ধ হয়েছে বা screen ঘুমিয়েছে | page আবার খুলে connect করুন |

---

## ৮. মনে রাখার বিষয়

1. **উড়ার আগে** সরকারি অনুমতি নিন। এই সফটওয়্যারের zone ও সতর্কতা সহায়তা মাত্র, অনুমতির বিকল্প নয়।
2. Connect হওয়ার পর Remote-এর Drone Fleet page **বন্ধ করা চলবে না**, আর screen ঘুমাতে দেওয়া যাবে না। পেছনে চললে
   চলবে কিনা, প্রথম উড়ানের আগে ধাপ ৯-এর পরীক্ষায় দেখে নিন।
3. প্রতি Remote **একবার** Approve দরকার। এটা নিরাপত্তার অংশ।
4. Password reset বা Unbind **উড়ানের মাঝে নয়**।
5. Alert শুধু dashboard-এ। যিনি alert দেখবেন তাঁকে dashboard খোলা রাখতে হবে।
6. স্ক্রিনশট আর flight-এর তথ্য সার্ভারে জমতে থাকে, নিজে মোছে না। জায়গা কমলে সার্ভার যিনি দেখেন তাঁকে বলুন।
7. Matrice 4T-সহ আসল hardware-এ পুরো পথ (Remote থেকে map পর্যন্ত) এখনো পরীক্ষা হয়নি। প্রথম আসল উড়ানে
   মাটিতে Remote চালু করে সব ধাপ সবুজ হচ্ছে কিনা আগে দেখে নিন।

বিস্তারিত ইংরেজি ম্যানুয়াল: `docs/user-manual.md`। Remote sign-in-এর প্রযুক্তিগত দিক: `docs/rc-login.md`।
