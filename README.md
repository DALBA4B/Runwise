# Runwise — AI Тренер для Бегунов

Веб-приложение для бегунов: автосинхронизация тренировок из Strava, AI-анализ, генерация недельных и долгосрочных планов, персональный чат с AI-тренером и продвинутая аналитика (VDOT, темповые/пульсовые зоны, дрейф пульса, прогнозы на дистанции).

## Технологии

| Фронтенд | Бэкенд | Сервисы |
|----------|--------|---------|
| React 18 + TypeScript | Node.js + Express | Supabase (PostgreSQL) |
| react-i18next (RU/EN/UK) | JWT авторизация | Strava API (OAuth + Webhook) |
| Recharts (графики) | SSE-стриминг | DeepSeek API (AI чат + tool-use) |
| PWA (service worker) | express-rate-limit | |

## Возможности

### Тренировки и синхронизация
- **Strava OAuth** — вход через Strava, импорт всей истории тренировок
- **Webhook авто-синхронизация** — новые тренировки появляются в приложении сразу после загрузки в Strava
- **Сплиты** — поддержка стандартных 1 км и более точных 500 м (пересчёт из streams)
- **HR streams** — посекундная запись пульса, кэшируется в БД для последующей аналитики
- **GPS-аномалии** — автодетекция подозрительных тренировок (нереалистичный темп, разрывы), ручное подтверждение/исправление

### AI тренер
- **Чат со стриминг-ответами** (SSE), история сохраняется в БД
- **Tool-use** — AI сам подгружает нужные данные через инструменты (поиск тренировок, статистика, прогнозы)
- **Анализ конкретной тренировки** — AI комментарий по запросу
- **Анализ недели** — общий вердикт по последним 7 дням
- **Персонализация** — пол тренера, длина ответов, характер, юмор, эмодзи
- **Лимит** — 15 сообщений/день для бесплатных юзеров, безлимит для премиум

### Планирование
- **Недельный план** — AI генерирует план на 7 дней с учётом последних тренировок
- **Макро-план** (долгосрочная периодизация) — план на N недель к целевой гонке (марафон/полумарафон/10к), с фазами Base/Build/Peak/Taper
- **Plan-vs-fact** — отслеживание выполнения макро-плана по неделям

### Физиология и аналитика
- **VDOT** — расчёт по личным рекордам (метод Daniels)
- **Pace-зоны** — Easy/Marathon/Threshold/Interval/Repetition из VDOT
- **HR-зоны** — три уровня точности:
  1. **Калибровка по реальным данным** — сопоставление пульса со сплитами в pace-зонах за 6 недель
  2. **Karvonen** (если есть пульс покоя)
  3. **%HRmax** (fallback)
- **Aerobic Threshold (AeT)** — детектор по дрейфу пульса в длительных
- **HR-чарт тренировки** — время в каждой зоне с цветовой полоской, мин/средний/макс пульс
- **Aerobic decoupling (дрейф пульса)** — насколько вырос пульс во второй половине тренировки при том же темпе
- **Прогнозы** — Riegel с поправкой на пульс, свежесть, best efforts из Strava
- **Reigel-страница диагностики** (`/diagnostics`) — пошаговая раскладка всех расчётов (VDOT, прогнозы, ACWR, monotony, 80/20, plan-vs-fact, training stability, marathon goal realism, weekly plan generation logic)

### Цели и рекорды
- **Цели** — объём (км/неделя), PB на дистанции (1/3/5/10/21/42 км) с дедлайнами и AI-прогнозом
- **Личные рекорды** — ручные и автоимпорт best efforts из Strava

### Прочее
- **Промокоды** — премиум на N дней или навсегда, одно/многоразовые, суммирование сроков
- **Админ-панель** (`/admin`) — управление промокодами, история активаций, мониторинг Strava API rate-limit и webhook лога
- **Локализация** — RU/EN/UK с автовыбором по языку браузера
- **PWA** — установка на телефон, оффлайн-кэш базовых ассетов
- **Mobile-first UI** — тёмная тема, max-width 420px, нижняя навигация, анимации переходов

## Структура проекта

```
├── client/                            # React фронтенд (TypeScript)
│   ├── public/                        # PWA манифест и service-worker
│   ├── src/
│   │   ├── api/api.ts                 # API клиент (REST + SSE)
│   │   ├── components/
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── GoalProgressMini.tsx
│   │   │   ├── HrChart.tsx            # График пульса с зонами + время в зонах
│   │   │   ├── MacroPlanTimeline.tsx  # Визуализация макро-плана по неделям
│   │   │   ├── MacroPlanView.tsx
│   │   │   ├── MetricCard.tsx
│   │   │   ├── PeriodComparison.tsx
│   │   │   ├── PlanRow.tsx
│   │   │   ├── WeekChart.tsx
│   │   │   └── WorkoutRow.tsx
│   │   ├── hooks/
│   │   │   ├── useAuth.ts
│   │   │   └── useWorkouts.ts
│   │   ├── config/metrics.ts          # Конфиг виджетов метрик
│   │   ├── screens/
│   │   │   ├── Home.tsx               # Главная: метрики, график недели, AI-анализ
│   │   │   ├── History.tsx            # История по месяцам
│   │   │   ├── WorkoutDetail.tsx      # Детали тренировки: сплиты, HR-чарт, дрейф, AI-разбор
│   │   │   ├── Plan.tsx               # Недельный план + переход к макро-плану
│   │   │   ├── AIChat.tsx             # Чат с AI тренером (SSE-стриминг)
│   │   │   ├── Profile.tsx            # Профиль, виджеты, физ. параметры, компоновка
│   │   │   ├── profile/
│   │   │   │   ├── GoalsSection.tsx
│   │   │   │   ├── PaceZonesSection.tsx  # VDOT, pace-зоны, HR-зоны, AeT
│   │   │   │   ├── RecordsSection.tsx
│   │   │   │   └── SettingsModal.tsx
│   │   │   ├── Diagnostics.tsx        # Полная диагностика расчётов
│   │   │   ├── AdminPanel.tsx         # Админ-панель промокодов
│   │   │   ├── Login.tsx
│   │   │   ├── ConsentScreen.tsx
│   │   │   └── PrivacyPolicy.tsx
│   │   ├── i18n/locales/              # ru.json, en.json, uk.json
│   │   ├── App.tsx                    # Корень: навигация, anim. переходы
│   │   └── utils.ts
│   └── .env.example
├── server/                            # Express бэкенд (Node.js)
│   ├── routes/
│   │   ├── ai/                        # AI модуль
│   │   │   ├── index.js               # Сборка под-роутеров
│   │   │   ├── chat.js                # /chat, /chat/stream, /chat/history, /chat/limit
│   │   │   ├── workout.js             # /analyze-workout
│   │   │   ├── plan.js                # /generate-plan, /plan, /weekly-analysis
│   │   │   ├── zones.js               # /pace-zones (VDOT + HR-зоны + AeT)
│   │   │   ├── macroPlan.js           # /macro-plan (GET/DELETE)
│   │   │   ├── diagnostics.js         # /diagnostics (пошаговая раскладка всех расчётов)
│   │   │   ├── context.js             # Загрузка данных юзера для AI/диагностики
│   │   │   ├── prompts.js             # Системные промпты, персонажи
│   │   │   ├── tools.js               # AI-инструменты (function calling)
│   │   │   ├── vdot.js                # VDOT и pace-зоны (Daniels)
│   │   │   └── deepseek.js            # Клиент DeepSeek (обычный + SSE)
│   │   ├── workouts/                  # Тренировки/цели/прогнозы
│   │   │   ├── index.js
│   │   │   ├── workouts.js            # CRUD, stats, weekly, comparison, anomalies
│   │   │   ├── goals.js               # /goals CRUD
│   │   │   ├── predictions.js         # /goals/predictions (Riegel + HR + freshness)
│   │   │   ├── riegelHelper.js        # Pure helper для расчётов прогнозов
│   │   │   └── state.js               # Кэш доступности колонок БД
│   │   ├── auth.js                    # Strava OAuth + JWT
│   │   ├── strava.js                  # Синхронизация, webhook, splits, streams, rate-limit
│   │   ├── profile.js                 # Профиль + личные рекорды
│   │   └── promo.js                   # Промокоды + админ-эндпоинты
│   ├── middleware/authMiddleware.js
│   ├── index.js                       # Точка входа + rate-limiters
│   ├── supabase.js
│   └── .env.example
├── supabase_schema.sql                # SQL схема БД
├── netlify.toml                       # Деплой фронта
├── railway.toml                       # Деплой бэка
└── package.json                       # Корневые скрипты для Railway monorepo
```

## Быстрый старт

### 1. Установка зависимостей

```bash
cd client && npm install
cd ../server && npm install
```

### 2. Настройка окружения

**Сервер** — скопируй `server/.env.example` → `server/.env`:

```env
PORT=3001
CLIENT_URL=http://localhost:3000

# Supabase (Settings > API)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key

# Strava (https://www.strava.com/settings/api)
STRAVA_CLIENT_ID=your-client-id
STRAVA_CLIENT_SECRET=your-client-secret
STRAVA_REDIRECT_URI=http://localhost:3000/callback

# DeepSeek (https://platform.deepseek.com)
DEEPSEEK_API_KEY=your-api-key

# JWT секрет (сгенерируй: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
JWT_SECRET=your-secret

# Админ-панель промокодов и админских эндпоинтов (любая случайная строка)
ADMIN_SECRET=your-admin-secret

# Strava webhook (любая случайная строка — должна совпадать с тем, что укажешь при регистрации webhook)
STRAVA_WEBHOOK_VERIFY_TOKEN=your-webhook-verify-token
```

**Клиент** — скопируй `client/.env.example` → `client/.env`:

```env
REACT_APP_API_URL=http://localhost:3001
```

### 3. База данных

1. Создай проект на [supabase.com](https://supabase.com)
2. Выполни `supabase_schema.sql` в SQL Editor — создаст все таблицы, индексы и колонки

### 4. Strava OAuth

1. Зайди на [strava.com/settings/api](https://www.strava.com/settings/api)
2. Создай приложение
3. Authorization Callback Domain: `localhost` (для разработки)
4. Скопируй Client ID и Secret в `server/.env`

### 5. Запуск

# Терминал 1
cd server
npm run dev

# Терминал 2
cd client
npm start

Приложение откроется на http://localhost:3000 либо же можно самому его там открытьмежду 

Чтобы запустить админ панель нужно открыть http://localhost:3000/admin 

## API

### Auth
| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/auth/strava` | URL для OAuth |
| POST | `/api/auth/callback` | Обмен кода на JWT |
| GET | `/api/auth/me` | Текущий пользователь |

### Тренировки
| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/workouts` | Список (фильтр: month, year, limit) |
| GET | `/api/workouts/:id` | Детали тренировки |
| PATCH | `/api/workouts/:id` | Подтвердить/исправить данные |
| POST | `/api/workouts/reanalyze` | Перепроверка GPS-аномалий |
| GET | `/api/workouts/stats?period=week\|month\|all` | Статистика |
| GET | `/api/workouts/weekly` | Км по дням (пн-вс) |
| GET | `/api/workouts/comparison` | Сравнение текущего и прошлого месяца |
| GET | `/api/workouts/goals/list` | Цели |
| POST | `/api/workouts/goals` | Создать цель |
| PUT | `/api/workouts/goals/:id` | Обновить цель |
| DELETE | `/api/workouts/goals/:id` | Удалить цель |
| GET | `/api/workouts/goals/predictions` | Прогнозы целей |

### Strava
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/strava/sync` | Импорт последних 50 тренировок |
| POST | `/api/strava/sync-all` | Импорт всей истории (фоновая задача) |
| POST | `/api/strava/sync-splits/:id` | Загрузка 1 км сплитов и best_efforts для тренировки |
| POST | `/api/strava/sync-splits-500/:id` | Расчёт 500 м сплитов из streams |
| POST | `/api/strava/sync-streams/:id` | Загрузка/кэширование raw streams (HR/distance/time) |
| GET | `/api/strava/sync-status` | Статус синхронизации (количество загруженных) |
| GET | `/api/strava/rate-limit` | Текущая нагрузка на Strava API (для юзера) |
| GET | `/api/strava/rate-limit/global` | Глобальная нагрузка по всем юзерам (admin) |
| GET | `/api/strava/webhook-log` | Лог webhook-событий (admin) |
| GET/POST | `/api/strava/webhook` | Strava webhook (verify + event) |

### AI
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/ai/chat` | Чат (обычный режим) |
| POST | `/api/ai/chat/stream` | Чат с SSE стримингом + tool-use |
| GET | `/api/ai/chat/limit` | Лимит сообщений (`isPremium`) |
| GET | `/api/ai/chat/history` | История чата |
| DELETE | `/api/ai/chat/history` | Очистить историю |
| POST | `/api/ai/analyze-workout` | AI-разбор конкретной тренировки |
| POST | `/api/ai/generate-plan` | Генерация недельного плана |
| GET | `/api/ai/plan` | Текущий недельный план |
| POST | `/api/ai/weekly-analysis` | Анализ последних 7 дней |
| GET | `/api/ai/pace-zones` | VDOT + pace-зоны + HR-зоны + AeT |
| GET | `/api/ai/macro-plan` | Активный макро-план + plan-vs-fact |
| DELETE | `/api/ai/macro-plan` | Отменить активный макро-план |
| GET | `/api/ai/diagnostics` | Полная пошаговая диагностика расчётов |

### Профиль
| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/profile` | Получить профиль |
| PUT | `/api/profile` | Обновить (age, height_cm, weight_kg, gender, ai_preferences, max_heartrate_user, resting_heartrate) |
| GET | `/api/profile/records` | Личные рекорды |
| PUT | `/api/profile/records` | Добавить/обновить рекорд |
| DELETE | `/api/profile/records/:type` | Удалить рекорд |

### Промокоды
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/promo/activate` | Активировать промокод |
| GET | `/api/promo/status` | Статус премиума |
| GET | `/api/promo/admin/codes` | Список кодов (admin) |
| POST | `/api/promo/admin/codes` | Создать код (admin) |
| DELETE | `/api/promo/admin/codes/:id` | Удалить код (admin) |
| GET | `/api/promo/admin/activations` | История активаций (admin) |

> Админские эндпоинты требуют заголовок `X-Admin-Secret` с значением из env `ADMIN_SECRET`.

## Система промокодов

- **Промокод** даёт безлимитный AI-чат на определённый срок (1-360 дней) или навсегда
- Коды бывают **одноразовые** (1 активация) и **многоразовые** (N активаций)
- При активации нескольких кодов **время суммируется**
- Один код можно активировать только один раз на юзера
- Премиум-пользователи не ограничены лимитом 15 сообщений/день
- **Админ-панель**: `http://localhost:3000/admin` — создание/удаление кодов, просмотр активаций

## Деплой

### Фронтенд → Netlify

1. Подключи GitHub репозиторий
2. Netlify подхватит `netlify.toml` автоматически
3. Добавь переменную: `REACT_APP_API_URL=https://твой-бэкенд.up.railway.app`

### Бэкенд → Railway

1. Подключи GitHub репозиторий
2. Root Directory: `server`
3. Добавь все переменные из `server/.env` (включая `ADMIN_SECRET`)
4. Обнови:
   - `CLIENT_URL` → URL фронтенда на Netlify
   - `STRAVA_REDIRECT_URI` → URL фронтенда + `/callback`

### После деплоя

- Обнови Authorization Callback Domain в настройках Strava API
- Убедись что CORS работает между фронтом и бэком
- Админ-панель будет на `https://твой-фронтенд.netlify.app/admin`

## Дизайн

- Mobile-first, max-width 420px
- Тёмная тема (синяя палитра)
- Нижняя навигация (5 вкладок)
- CSS Custom Properties для кастомизации
- Анимации переходов между экранами

## База данных

| Таблица | Описание |
|---------|----------|
| `users` | Пользователи, Strava токены, физ. параметры (age/height/weight/gender, max/resting HR), AI-настройки, премиум-статус (`premium_until`, `is_lifetime_premium`) |
| `workouts` | Тренировки из Strava: дистанция, время, темп, пульс, сплиты (1 км и 500 м), best efforts, raw streams (HR/distance/time), GPS-аномалии, ручные правки (`manual_distance`, `manual_moving_time`) |
| `plans` | Недельные тренировочные планы от AI |
| `macro_plans` | Долгосрочные периодизированные планы (12-24+ недель к гонке) с фазами Base/Build/Peak/Taper |
| `goals` | Цели пользователей (объём, PB) с дедлайнами и кэшированным `predicted_time` |
| `personal_records` | Личные рекорды по дистанциям (1/3/5/10/21/42 км), ручные или из Strava best efforts |
| `chat_messages` | История чата с AI тренером |
| `promo_codes` | Промокоды (длительность, лимит использований, активность) |
| `promo_activations` | Активации промокодов пользователями (с датой истечения) |

## Rate-limits

Применяются на бэке через `express-rate-limit` (per-IP, окно 1 минута):

| Группа эндпоинтов | Лимит/мин |
|-------------------|-----------|
| Общий `/api/*` | 100 |
| `/api/auth/*` | 10 |
| `/api/ai/*` | 20 (DeepSeek платный) |
| `/api/promo/*` | 15 (защита от brute-force) |

Также трекается потребление Strava API (1000 запросов/15мин) с разбивкой по юзерам — доступно через `/api/strava/rate-limit/global`.

## Strava Webhook

Для автоматической синхронизации новых тренировок:

1. Зарегистрируй подписку через Strava API (один раз):
   ```bash
   curl -X POST https://www.strava.com/api/v3/push_subscriptions \
     -F client_id=YOUR_CLIENT_ID \
     -F client_secret=YOUR_CLIENT_SECRET \
     -F callback_url=https://your-backend.up.railway.app/api/strava/webhook \
     -F verify_token=YOUR_STRAVA_WEBHOOK_VERIFY_TOKEN
   ```
2. После одобрения Strava будет слать события на `/api/strava/webhook` (POST), а сервер сам подтянет новую тренировку, сплиты, streams и сохранит в БД.
3. Лог последних webhook-событий доступен админу через `/api/strava/webhook-log`.

---

**Runwise** — open source, для личного использования и обучения.
