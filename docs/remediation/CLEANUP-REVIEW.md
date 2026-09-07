# فائلوں کی نشان دہی اور محفوظ علیحدگی — مستقل فہرست

۲۸ اگست ۲۰۲۶۔ فائلوں کی صفائی کے اس عمل میں کوئی فائل حذف نہیں کی گئی۔ مرحلہ پنجم کے عارضی آزمائشی معلومات والے الگ واقعے اور بحالی کی حد کے لیے `PHASE-FIVE.md` دیکھیں۔

## ہر مرحلے کا مستقل اصول

صارف کی ہدایت کے مطابق ہر اجازت یافتہ مرحلے میں فائلوں کی ضرورت، حوالوں اور محفوظ علیحدگی کی فہرست تازہ ہوگی۔ واقعی غیر ضروری ثابت ہونے والی فائل اور صرف جائزے کے قابل تاریخی ثبوت الگ زمرے ہیں۔ حذف بعد کی الگ اجازت سے ہوگا۔ ایپ، درآمدی رابطے، آزمائش، چلتا ماحول، راز اور محفوظ نقل صرف یکساں مواد ہونے کی وجہ سے نہیں ہٹائے جائیں گے۔

## آٹھواں مرحلہ — کتابتوں اور موبائل تعمیر کی آخری فہرست

۳۰ اگست ۲۰۲۶۔ تازہ درجہ بندی `cleanup-review/2026-08-30-phase-eight-dependencies-final/manifest.json` میں ہے۔ ۱۰۷۷ ماخذ/آزمائشی/دستاویزی فائلیں دیکھی گئیں؛ ۱۲۳ تاریخی رپورٹوں میں سے ۱۲۱ سابق شناخت شدہ محفوظ حوالوں سے دوبارہ استعمال ہوئیں اور صرف بدلی ہوئی دو رپورٹوں کی نئی نقل بنی۔ کوئی اصل فائل منتقل یا حذف نہیں ہوئی۔

- `.dependency-trials/phase-eight-firebase-admin-14/` کامیاب الگ کتابتی تجربہ ہے؛ حتمی لاک فائلوں میں نتیجہ آچکا، اس لیے آئندہ واضح صفائی اجازت پر حذف امیدوار ہے۔
- `emulator-data/phase-seven-mobile-2026-08-29T19-46-34-727Z/` گاہک/ڈرائیور تعمیر ثبوت اور `emulator-data/phase-seven-mobile-2026-08-30T01-09-45-946Z/` آخری مالک تعمیر ثبوت ہے۔ ثبوت قبول کیے بغیر انہیں حذف نہ کیا جائے۔
- اس سے پرانے `emulator-data/phase-seven-mobile-*` فولڈر ممکنہ زائد تعمیراتی نقول ہیں؛ آخری دو ثبوت، پیکج شناخت اور اصل فون قبولیت محفوظ کرنے کے بعد ہی الگ کیے جائیں۔
- `hosting-dist/`، تینوں `node_modules`، اینڈرائڈ `build` اور ایمولیٹر معلومات دوبارہ بن سکتے ہیں، مگر چلتی مقامی جانچ اور واپسی کے لیے ابھی محفوظ ہیں۔
- نئی فعال لاک فائلیں، `mobile-verify.mjs`، معیار دروازہ، جدید انتظامی سرور ماڈیول اور اینڈرائڈ ترتیب ضروری ماخذ ہیں؛ صفائی امیدوار نہیں۔
- تفصیلی کتابتی فیصلہ `dependency-review.json` اور تکمیل `completion.json` میں ہے۔ گریڈل ۹ کی فرسودہ خصوصیات اور `flatDir` تنبیہ آئندہ اصلاح ہیں، حذف کی اجازت نہیں۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-30-phase-eight-dependencies-final
```

## آٹھواں مرحلہ — مشترکہ ماخذ اور ساختی فہرست

۲۹ اگست ۲۰۲۶۔ تازہ درجہ بندی `cleanup-review/2026-08-29-phase-eight-structural-local/manifest.json` میں ہے۔ ۱۰۷۴ ماخذ/آزمائشی/دستاویزی فائلیں دیکھی گئیں؛ ۱۲۳ تاریخی رپورٹوں میں سے ۱۲۲ سابق شناخت شدہ محفوظ حوالوں سے دوبارہ استعمال ہوئیں اور صرف بدلی ہوئی جامع معائنہ رپورٹ کی ایک نئی نقل بنی۔ کوئی اصل فائل منتقل یا حذف نہیں ہوئی۔

- `shared/js/` اب ۹۱ موجود ایپ پردوں کا اصل ماخذ ہے؛ باریک پردے فعال درآمدی راستے ہیں، اس لیے زائد یا قابلِ حذف نہیں۔
- `ride-radar-feed-hub.mjs`، `quality-gate.mjs`، `source-syntax-check.mjs` اور آٹھویں مرحلے کی آزمائشیں لازمی فعال فائلیں ہیں۔
- `hosting-dist`، اینڈرائڈ `build`، موبائل/سرور `node_modules` اور تاریخی نتیجہ فائلیں آئندہ صفائی کے الگ امیدوار ہیں؛ موجودہ مرحلے میں حذف کی اجازت نہیں۔
- تفصیلی فیصلہ `phase-eight-review.json` میں ہے۔ یکساں مواد کے ۱۰۱ گروہ صرف جائزہ ہیں، حذف کا ثبوت نہیں۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-29-phase-eight-structural-local
```

## ساتواں مرحلہ — مقامی پی ٹو پی کی حتمی فہرست

۲۹ اگست ۲۰۲۶۔ حتمی درجہ بندی `cleanup-review/2026-08-29-phase-seven-native-p2p-final-3/manifest.json` میں ہے۔ ۱۲۳ تاریخی رپورٹیں نئی نقل بنانے کے بجائے پہلے سے جانچے محفوظ حوالوں سے منسلک ہیں۔ اصل ماخذ فائل حذف یا منتقل نہیں ہوئی۔

- نئی `mobile/p2p-shared/` فائلیں دونوں ایپس کی فعال تعمیر کا لازمی حصہ ہیں؛ انہیں زائد نہ سمجھا جائے۔
- حتمی محفوظ تعمیر `emulator-data/phase-seven-mobile-2026-08-29T11-03-05-579Z` قبولیتی ثبوت ہے اور اصل اجرا نہیں۔
- اس سے پہلے کی `phase-seven-mobile-*` نقلیں، `mobile-lock-refresh-2026-08-29` تجربہ، گریڈل `build`، موبائل `www`، تیار غیر دستخط شدہ پیکج، نقشہ اور علامتی فائلیں مستقبل کی صفائی کے امیدوار ہیں۔ تازہ حتمی نقل قبولیت مکمل ہونے تک محفوظ رہے گی۔
- پرانے تین نمونہ آلہ امتحانات حقیقی سواری قبولیت نہیں؛ اصل فون مرحلے میں بدل کر ہی حذف/الگ کیے جائیں۔
- پرانے متنی پی ٹو پی/پس منظر امتحانات تاریخی ثبوت ہیں؛ نئے امتحانات میں مفید شرط منتقل کیے بغیر حذف نہ ہوں۔
- عارضی مقفل فہرست میں غیر موافق `tar 7` زبردستی لگانے کا تجربہ حتمی ماخذ میں شامل نہیں کیا گیا۔ یہ تجرباتی فولڈر بعد کی واضح صفائی اجازت پر پہلے امیدواروں میں ہے۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-29-phase-seven-native-p2p-final-3
```

## ساتواں مرحلہ — موبائل حفاظتی حصے کا جائزہ

۲۹ اگست ۲۰۲۶۔ ۱۰۶۴ ماخذ، آزمائشی اور دستاویزی فائلوں کی تازہ درجہ بندی؛ ۱۲۳ تاریخی رپورٹوں کے سابق شناخت سے جانچے ہوئے حوالے `cleanup-review/2026-08-29-phase-seven/manifest.json` میں جمع ہیں۔

- اصل منتقل/حذف شدہ فائل: صفر؛ نئی دہرائی رپورٹ نقل: صفر؛ سابق محفوظ حوالے: ۱۲۳۔
- ۱۰۰ یکساں مواد والے گروہ صرف جائزے کے لیے؛ نئی حفاظتی فائلیں اور مشترکہ مقامی پُل ضروری ہیں۔
- سات پرانے موبائل مددگار/آزمائشی راستوں کا الگ نشان، وجہ اور سابق محفوظ نسخے کا شناختی حوالہ اسی جگہ `mobile-review.json` میں جمع ہے۔ دو پرانے مددگار اب حفاظتی روک/صرف جانچ ہیں؛ ان کے موجودہ حکموں کے حوالے منتقل کیے بغیر انہیں حذف نہ کیا جائے۔
- تین نمونہ آلہ تجربے بھی اسی فہرست میں الگ نشان زد ہیں؛ وہ سابق غلط پیکیج نام کی توقع رکھتے ہیں۔ انہیں حقیقی فون کی کامیاب قبولیت میں نہیں گنا گیا؛ آلہ آزمائشی مرحلے میں بدلنا ضروری ہے۔
- پرانے موبائل متنی تجربات موجودہ نئے نفاذ کی مکمل آزمائش نہیں۔ تاریخی نتائج پر دوبارہ نہیں لکھا گیا؛ تازہ ثبوت `emulator-data/phase-seven-*` میں ہیں۔
- ابتدائی اور تازہ الگ موبائل تعمیراتی فولڈر الگ نشان زد ہیں۔ اصل موبائل `www`، اصل ویب پیکج، سابق محفوظ نقلیں، کتابتیں اور صارف کے اصل ریکارڈ نہیں مٹائے گئے۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-29-phase-seven
```

## چھٹا مرحلہ — منظور شدہ پالیسی کے نفاذ کا تازہ جائزہ

۱۰۴۶ ماخذ، آزمائشی اور دستاویزی فائلوں کی تازہ درجہ بندی؛ ۱۲۳ تاریخی رپورٹیں سابق محفوظ، شناخت سے جانچے ہوئے حوالوں کے ساتھ `cleanup-review/2026-08-28-phase-six-approved/manifest.json` میں جمع ہیں۔ اصل تاریخی رپورٹیں اپنی جگہ رہیں گی۔

- نئی منتقل شدہ اصل فائل: صفر؛ نئی دہرائی ہوئی رپورٹ نقل: صفر؛ سابق جانچے ہوئے محفوظ حوالے: ۱۲۳۔
- ۹۸ یکساں مواد والے گروہ صرف مزید جائزے کے لیے؛ ان کی یکسانیت حذف کی اجازت نہیں۔ اس تسلسل میں کسی مزید اصل فائل کو یقینی غیر ضروری قرار نہیں دیا گیا۔
- نئی مدت، شناختی/ذاتی صفائی، سپر ایڈمن، قانونی صفحات اور آزمائشی فائلیں ضروری حفاظتی اجزا ہیں، زائد فائلیں نہیں۔
- اصل ویب پیکج کی ۳۹۹ فائلیں اور تاریخی ۱۲۳ رپورٹیں اس تسلسل سے پہلے کی جانچی ہوئی نقل کے مطابق بغیر تبدیلی محفوظ ہیں۔
- تازہ نتائج `emulator-data/phase-six-approved-*.tap` اور `emulator-data/phase-six-approved-hosting-final.json` میں ہیں۔ ان میں ادھورے ابتدائی اجرا اور مکمل اعادے الگ ہیں؛ جزوی نتیجہ کامیاب مکمل جانچ نہیں۔
- چوتھے مرحلے کے دو عارضی لاگ بدستور اسی سابق قابلِ واپسی ذخیرے میں ہیں۔ نئے اصل لاگ، راز، محفوظ نقلیں، کتابتیں یا موبائل پیکج خود سے منتقل/حذف نہیں کیے گئے۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-28-phase-six-approved
```

## چھٹا مرحلہ — پالیسی منظوری سے پہلے کا جائزہ

۱۰۳۹ دستیاب ماخذ/آزمائشی/دستاویزی فائلوں کی درجہ بندی؛ ۱۲۳ تاریخی رپورٹوں کے محفوظ حوالے `cleanup-review/2026-08-28-phase-six/manifest.json` میں درج ہیں۔ ان کی موجودہ شناخت مرحلہ ششم سے پہلے کی مکمل نقل اور سابق محفوظ رپورٹوں دونوں سے برابر ہے۔ غیر تبدیل شدہ رپورٹوں کی مزید دہرائی ہوئی نقل نہیں بنائی گئی۔

- نئی منتقل شدہ فائل: صفر؛ نئی نقل: صفر؛ جانچے ہوئے سابق محفوظ حوالے: ۱۲۳۔
- ۹۸ یکساں مواد کے گروہ جائزے کے لیے برقرار؛ مزید کوئی فائل یقینی غیر ضروری ثابت نہیں ہوئی۔ مشترکہ درآمدی فائلیں اور نئے حفاظتی/آزمائشی اجزا ضروری ہیں۔
- چوتھے مرحلے کے دو عارضی لاگ اسی سابق قابلِ واپسی ذخیرے میں ہیں؛ اصل ۱۲۳ تاریخی رپورٹیں اپنی جگہ برقرار ہیں۔
- چھٹے مرحلے کے نئے نتائج `emulator-data/phase-six-*.tap` اور `emulator-data/phase-six-hosting-final-report.json` میں ہیں؛ اصل تاریخی رپورٹ پر نہیں لکھے گئے۔
- اصل `hosting-dist` کی فائلوں کی شناخت برقرار ہے۔ اس کا سابق دستی پیش منظر دستیاب نہیں ملا؛ فائلوں کی حفاظت کو چلتی ایپ کی تصدیق نہ سمجھا جائے۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-28-phase-six
```

نئی فہرست کے محفوظ حوالے پہلے سے موجود جانچی ہوئی رپورٹ فائل تک جاتے ہیں۔ موجودہ اور سابق ذخیرے دونوں برقرار رہیں؛ بعد کی صفائی میں انہیں الگ دیکھے بغیر حذف نہ کریں۔ اس مرحلے میں اصل فائل حذف یا مزید اصل فائل کی منتقلی نہیں ہوئی۔

## پانچواں مرحلہ — سابق جائزہ

۱۰۳۰ دستیاب ماخذ/آزمائشی/دستاویزی فائلوں کی درجہ بندی؛ ۱۲۳ تاریخی رپورٹوں کے محفوظ حوالے `cleanup-review/2026-08-28-phase-five/manifest.json` میں درج ہیں۔ تمام ۱۲۳ کی شناخت سابق ذخیرے سے برابر ہے؛ اس لیے نئی دہرائی ہوئی نقل نہیں بنائی گئی۔ فہرست کا ہر `reusedFrom` سابق محفوظ فائل کا صحیح راستہ بتاتا ہے۔ تصدیق میں موجودہ فہرست اور سابق محفوظ فائلیں دونوں جانچی جاتی ہیں۔

- نئی منتقل شدہ فائل: صفر؛ نئی نقل: صفر؛ جانچے ہوئے سابق محفوظ حوالے: ۱۲۳۔
- ۹۸ یکساں مواد کے گروہ جائزے کے لیے برقرار؛ اس مرحلے میں کوئی مزید فائل یقینی غیر ضروری ثابت نہیں ہوئی۔
- چوتھے مرحلے کے دونوں عارضی لاگ اسی سابق محفوظ ذخیرے میں موجود ہیں۔ اصل ۱۲۳ رپورٹ فائلیں اپنی جگہ برقرار ہیں۔
- نئی آزمائشوں کے نتائج `emulator-data/phase-five-server-checks/` اور `emulator-data/phase-five-legacy-results/` میں ہیں؛ انہیں پرانے ثبوت پر نہیں لکھا گیا۔ دیگر منتخب پرانی آزمائشوں کی محفوظ نئی تحریریں سابق الگ آزمائشی نتیجہ فولڈر میں ہیں۔

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-28-phase-five
```

موجودہ اور سابق دونوں ذخیرے درکار ہیں؛ سابق کو حذف کرکے نئے حوالوں کو بے اثر نہ کریں۔ آئندہ بدلی ہوئی رپورٹ کی صرف نئی نقل بنے گی؛ غیر تبدیل شدہ رپورٹ کا جانچا ہوا سابق حوالہ برقرار ہوگا۔ اس اضافے کی تین نئی آزمائشوں سمیت ذخیرے کی ۱۱ آزمائشیں کامیاب ہیں۔

## چوتھا مرحلہ — سابق نتیجہ

۱۰۲۰ دستیاب ماخذ/آزمائشی/دستاویزی فائلوں کی درجہ بندی کی گئی۔ محفوظ نقلیں، چلتا مقامی ماحول، کتابتیں، خفیہ ترتیب اور موبائل کے بنے ہوئے پیکج الگ محفوظ زمرے ہیں؛ انہیں غیر ضروری قرار نہیں دیا گیا۔

۱۲۵ فائلیں `cleanup-review/2026-08-28-phase-four/` میں اکٹھی ہیں:

- ۲ بے حوالہ عارضی لاگ اصل جگہ سے `moved/tests/` میں منتقل ہوئے؛ ان کی اضافی نقل `files/tests/` میں بھی ہے۔
- ۱۲۳ تاریخی نتیجہ/رپورٹ فائلوں کی صرف نقل `files/tests/` میں رکھی گئی۔ ان میں ۱۱۴ کے متنی حوالے دوسری فائلوں میں ملے؛ اس لیے اصل فائلیں نہیں ہٹائی گئیں۔
- ۹۸ یکساں مواد والے گروہ بھی نشان زد ہیں۔ یکساں مواد غیر ضروری ہونے کا ثبوت نہیں: ایپ کے درآمدی راستے، مشترکہ فائلیں اور بننے والے پیکج ان پر منحصر ہو سکتے ہیں۔ اصل فائلیں برقرار ہیں۔

صرف دو لاگ **ثابت شدہ غیر ضروری عارضی فائلیں** ہیں۔ باقی مجموعہ **بعد کی صفائی کے جائزے** کے لیے ہے، حذف کی منظوری نہیں۔ متحرک درآمد/بیرونی استعمال کی وجہ سے محض متنی تلاش پورے نظام میں عدم استعمال کی قطعی ضمانت نہیں۔

## محفوظ ذخیرہ

`manifest.json` میں ہر فائل کا اصل راستہ، جمع شدہ راستہ، حجم، شناختی خلاصہ، وجہ، حوالہ دینے والی فائلیں، تمام ماخذ کی درجہ بندی اور یکساں مواد کے گروہ موجود ہیں۔ `manifest.sha256` اس فہرست کی شناخت ہے۔ ذخیرہ جانچا گیا ہے؛ اس میں اصل صارف لاگ/نتائج ہو سکتے ہیں، اسے عوامی ویب پیکج یا مخزن میں شامل نہ کریں۔ `.gitignore` اسے خارج کرتا ہے۔

اس ذخیرے سے پہلے کی مکمل جانچی ہوئی نقل:

`.release-baselines/2026-08-28T10-03-45-946Z-before-phase-four-4a5cee`

اس میں منتقل ہونے والے دونوں لاگ اپنی اصل جگہ کے تحت بھی محفوظ ہیں۔ **چوتھے مرحلے کی اس علیحدگی** میں `hosting-dist`، مقامی کھلی ایپس، ان کا معلوماتی ذخیرہ، `.firebase`، `node_modules`، راز اور سابق محفوظ نقلیں نہیں چھیڑی گئیں۔

## بعد میں جانچ اور واپسی

یہ احکامات منصوبے کی جڑ سے چلیں گے؛ کوئی زندہ سروس نہیں بدلتے:

```text
node tools/cleanup-review.mjs verify cleanup-review/2026-08-28-phase-four
node tools/cleanup-review.mjs restore-logs cleanup-review/2026-08-28-phase-four
```

دوسرا حکم صرف منتقل ہوئے دونوں لاگ واپس **نقل** کرے گا؛ محفوظ ذخیرہ برقرار رہے گا۔ اگر اصل جگہ نئی فائل موجود ہو تو پورا واپسی عمل شروع ہونے سے پہلے رک جائے گا، کچھ اوپر نہیں لکھے گا۔

آٹھ خودکار آزمائشیں: محدود راستے، ضروری فائلوں کا تحفظ، حوالہ ملنے پر منتقل نہ کرنا، شناختی جانچ، موجودہ ذخیرہ نہ بدلنا، مکمل واپسی اور نئی صارف فائل پر نہ لکھنا — کامیاب۔

## جمع شدہ فائلوں کی مکمل فہرست

حوالہ شمار صرف ماخذ/دستاویز میں واضح فائل نام کی تلاش ہے، مکمل استعمال کا ثبوت نہیں۔ تفصیلی حوالہ جاتی راستے اصل فہرست میں ہیں۔

| اصل فائل | کیا کیا گیا | واضح حوالے |
|---|---|---|
| tests/_run-cp.log | منتقل، قابلِ واپسی | 0 |
| tests/_v-cp.log | منتقل، قابلِ واپسی | 0 |
| tests/admin-owner-applications-ui-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/audit-results.json | صرف نقل؛ اصل برقرار | 14 |
| tests/auth-routing-matrix-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/background-location-upload-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/booking-cancellation-contract-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/booking-false-success-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/breadcrumb-batching-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/breadcrumb-hardening-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/breadcrumb-telemetry-rules-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/checkpoint-policy-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/cross-device-validation-phase4-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/customer-location-report-counters-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/customer-map-follow-driver-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/customer-marker-motion-continuity-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/customer-p2p-background-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/diagnostics-canonical-boundary-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/dispatch-booking-radar-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/dispatch-online-ready-rules-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/dispatch-readiness-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/driver-active-ride-pointer-heal-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/driver-active-ride-reconcile-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/driver-fresh-location-online-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/emergency-fix-final-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/emergency-fix-verification-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ghost-rides-driver-location-expiry-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/hosting-build-order-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/hosting-routing-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/hosting-startup-health-live-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/hosting-startup-health-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/idle-location-cost-controls-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/integration-regression-restore-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/live-location-foundation-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/load-capacity-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/map-cold-startup-diagnostic-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/map-init-recovery-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/owner-authorization-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/owner-onboarding-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/p1a-option-a-lab-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/p1a-predeploy-final-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p1a-runtime-verification-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/p2p-comm-device-path-report.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-comm-emergency-deploy-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/p2p-comm-phase1-report.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-comm-phase2-report.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-comm-phase3-report.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-comm-phase4-report.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-comm-phase5-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/p2p-customer-receive-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/p2p-pipeline-diag-deploy-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/p2p-pipeline-root-cause-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/p2p-reliability-upgrade-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/p2p-webrtc-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/phase1-emulator-results.json | صرف نقل؛ اصل برقرار | 9 |
| tests/phase2a-bargaining-results.json | صرف نقل؛ اصل برقرار | 5 |
| tests/phase2a-emulator-results.json | صرف نقل؛ اصل برقرار | 6 |
| tests/phase2a-settlement-results.json | صرف نقل؛ اصل برقرار | 5 |
| tests/phase2b-emulator-results.json | صرف نقل؛ اصل برقرار | 4 |
| tests/phase2b-security-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase2c-canonical-audit-results.json | صرف نقل؛ اصل برقرار | 4 |
| tests/phase2c-e2e-results.json | صرف نقل؛ اصل برقرار | 5 |
| tests/phase2c-emulator-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase2d-functions-runtime-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase2e-browser-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase3a-inventory-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase3a-per-ride-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase3b-matching-results.json | صرف نقل؛ اصل برقرار | 4 |
| tests/phase4a-ui-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/phase4b-a11y-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/phase4d-responsive-results.json | صرف نقل؛ اصل برقرار | 4 |
| tests/phase4e-account-deletion-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/phase4e-trust-results.json | صرف نقل؛ اصل برقرار | 4 |
| tests/phase4f-ops-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase4f-pin-inventory-results.json | صرف نقل؛ اصل برقرار | 0 |
| tests/phase4f-storage-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/phase4g-android-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/phase4h-pilot-results.json | صرف نقل؛ اصل برقرار | 3 |
| tests/post-fix-map-browser-diagnostic-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-lifecycle-timestamps-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-admin-config-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-admin-ui-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-foundation-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-hardening-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-ride-end-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-rules-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/ride-location-report-submit-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/road-routing-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/road-snapping-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/runtime-consistency-final-audit-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/runtime-consistency-phase1-report.json | صرف نقل؛ اصل برقرار | 0 |
| tests/runtime-consistency-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/runtime-validation-phase3-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage1-bootstrap-assignment-contract-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage1-live-driver-motion-diagnosis-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage1-live-motion-reliability-audit-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage1-reconciliation-audit-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage2-ack-semantics-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage2-assignment-version-sync-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage2-bootstrap-assignment-fix-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage2-driver-controller-reconciliation-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage3-assignment-identity-stability-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage3-customer-controller-reconciliation-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage3-driver-p2p-presence-independence-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage3-same-ride-reassignment-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage4-failed-send-retry-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage4-native-credential-continuity-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage4-peer-session-delivery-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage4-responsive-firebase-fallback-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage5-android-service-lifecycle-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage5-cadence-contract-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage5-e2e-marker-motion-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage5-full-chain-marker-motion-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage6-cloud-functions-audit-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage6-customer-wake-lock-renewal-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage6-native-fallback-audit-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage7-release-readiness-report.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage7-sequence-strictness-results.json | صرف نقل؛ اصل برقرار | 2 |
| tests/stage8-main-alignment-audit-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage8-tranche2-blank-gap-ride-switch-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage8-tranche3-idle-index-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage8-tranche4-owner-admin-hosting-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/stage8-trust-anchor-port-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/startup-module-graph-profile-results.json | صرف نقل؛ اصل برقرار | 1 |
| tests/viewer-presence-lifecycle-results.json | صرف نقل؛ اصل برقرار | 1 |

## آئندہ صفائی کی ترتیب

۱۔ محفوظ ذخیرے کی شناخت دوبارہ جانچیں اور ہر اصل رپورٹ کے موجودہ حوالے دیکھیں۔
۲۔ آزمائشی دروازوں اور دستاویزوں کے حوالے محفوظ نئی جگہ کی طرف منتقل کرنے کے بعد ہی باقی اصل رپورٹوں کی علیحدگی پر فیصلہ کریں۔
۳۔ یکساں مشترکہ کوڈ/درآمدی فائلوں کی صفائی مرحلہ ہشتم میں پیکج کی درآمدی جانچ کے ساتھ ہوگی۔
۴۔ چلتے ماحول، معلوماتی ذخیرے، کتابتوں یا محفوظ نقلوں کی صفائی الگ واضح اجازت اور واپسی کی تصدیق کے بعد ہوگی۔ اس مرحلے میں کوئی حذف نہیں ہوا۔
