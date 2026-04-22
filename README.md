# Runwise — AI Тренер для Бегунов

Веб-приложение для бегунов: синхронизация тренировок из Strava, AI-анализ, генерация планов и персональный чат с AI-тренером.

## Технологии

| Фронтенд | Бэкенд | Сервисы |
|----------|--------|---------|
| React 18 + TypeScript | Node.js + Express | Supabase (PostgreSQL) |
| React-i18next (RU/EN/UK) | JWT авторизация | Strava API (OAuth) |
| Recharts (графики) | SSE стриминг | DeepSeek API (AI) |
| PWA | Промокоды + Админка | |

## Возможности

- **Strava интеграция** — OAuth авторизация, импорт тренировок и сплитов
- **AI тренер** — персональный чат со стриминг-ответами, учитывает историю тренировок, цели, физические параметры
- **Планы тренировок** — AI генерирует недельный план, можно менять прямо в чате
- **Цели** — установка целей (объём, личные рекорды) с дедлайнами и прогнозами
- **Личные рекорды** — ручные и из Strava (1км, 3км, 5км, 10км, полумарафон, марафон)
- **Аналитика** — статистика за неделю/месяц/всё время, сравнение периодов, настраиваемые виджеты
- **GPS-аномалии** — автоматическое обнаружение подозрительных данных тренировок
- **Промокоды** — система премиум-доступа: безлимитный AI-чат, суммирование сроков, одноразовые/многоразовые коды
- **Админ-панель** — создание/управление промокодами, история активаций (доступ по `/admin`)
- **Локализация** — русский, английский, украинский (автовыбор по языку браузера)
- **AI-персонализация** — пол тренера, длина ответов, характер, юмор, эмодзи
- **Профиль** — возраст, рост, вес, пол для персонализации AI-рекомендаций
- **PWA** — можно установить на телефон как приложение

## Структура проекта

```
├── client/                  # React фронтенд
│   ├── public/              # PWA манифест, service worker
│   ├── src/
│   │   ├── api/api.ts       # API клиент (REST + SSE стриминг)
│   │   ├── components/      # UI компоненты
│   │   │   ├── ChatMessage.tsx
│   │   │   ├── GoalProgressMini.tsx
│   │   │   ├── MetricCard.tsx
│   │   │   ├── PeriodComparison.tsx
│   │   │   ├── PlanRow.tsx
│   │   │   ├── WeekChart.tsx
│   │   │   └── WorkoutRow.tsx
│   │   ├── hooks/           # React хуки
│   │   │   ├── useAuth.ts
│   │   │   └── useWorkouts.ts
│   │   ├── config/
│   │   │   └── metrics.ts   # Конфиг виджетов метрик
│   │   ├── screens/         # Экраны приложения
│   │   │   ├── Home.tsx         # Главная — метрики, график, AI-анализ
│   │   │   ├── History.tsx      # История тренировок по месяцам
│   │   │   ├── WorkoutDetail.tsx # Детали тренировки + сплиты
│   │   │   ├── Plan.tsx         # Недельный план от AI
│   │   │   ├── AIChat.tsx       # Чат с AI тренером
│   │   │   ├── Profile.tsx      # Профиль: виджеты, физ. параметры, компоновка
│   │   │   ├── profile/         # Подкомпоненты профиля
│   │   │   │   ├── GoalsSection.tsx   # Цели: CRUD, прогресс, прогнозы
│   │   │   │   ├── RecordsSection.tsx # Личные рекорды: CRUD
│   │   │   │   └── SettingsModal.tsx  # Настройки, язык, промокод, logout
│   │   │   ├── AdminPanel.tsx   # Админ-панель промокодов
│   │   │   ├── Login.tsx        # Вход через Strava
│   │   │   ├── ConsentScreen.tsx # Согласие на обработку данных
│   │   │   └── PrivacyPolicy.tsx # Политика конфиденциальности
│   │   ├── i18n/            # Локализация
│   │   │   ├── index.ts
│   │   │   └── locales/
│   │   │       ├── ru.json
│   │   │       ├── en.json
│   │   │       └── uk.json
│   │   ├── App.tsx          # Роутинг и навигация
│   │   ├── App.css          # Все стили
│   │   └── utils.ts         # Форматирование (темп, дистанция)
│   └── .env.example
├── server/                  # Express бэкенд
│   ├── routes/
│   │   ├── ai/              # AI модуль (чат, планы, анализ)
│   │   │   ├── index.js     # Роуты: чат, план, анализ (лимит 15 сообщ/день)
│   │   │   ├── context.js   # Загрузка данных из БД для AI контекста
│   │   │   ├── prompts.js   # Системные промпты, персонажи, форматирование
│   │   │   ├── tools.js     # AI-инструменты (поиск тренировок, статистика)
│   │   │   └── deepseek.js  # Вызовы DeepSeek API (обычный + стриминг)
│   │   ├── auth.js          # Strava OAuth + JWT
│   │   ├── strava.js        # Синхронизация тренировок
│   │   ├── workouts.js      # Тренировки, статистика, цели
│   │   ├── profile.js       # Профиль и личные рекорды
│   │   └── promo.js         # Промокоды и админ-эндпоинты
│   ├── middleware/
│   │   └── authMiddleware.js
│   ├── index.js             # Точка входа сервера + rate limiting
│   ├── supabase.js          # Клиент БД
│   └── .env.example
├── supabase_schema.sql      # SQL схема базы данных
├── netlify.toml             # Конфиг деплоя фронтенда
├── railway.toml             # Конфиг деплоя бэкенда
└── .gitignore
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

# Админ-панель промокодов (любой пароль)
ADMIN_SECRET=your-admin-secret
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
| POST | `/api/strava/sync-all` | Импорт всей истории (фон) |
| POST | `/api/strava/sync-splits-500/:id` | Загрузка 500м сплитов |
| GET | `/api/strava/sync-status` | Статус синхронизации |

### AI
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/ai/chat` | Чат (обычный) |
| POST | `/api/ai/chat/stream` | Стриминг чат (SSE) |
| GET | `/api/ai/chat/limit` | Лимит сообщений (isPremium) |
| GET | `/api/ai/chat/history` | История чата |
| DELETE | `/api/ai/chat/history` | Очистить историю |
| POST | `/api/ai/analyze-workout` | Анализ тренировки |
| POST | `/api/ai/generate-plan` | Генерация плана |
| GET | `/api/ai/plan` | Текущий план |
| POST | `/api/ai/weekly-analysis` | Анализ недели |

### Профиль
| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/profile` | Получить профиль |
| PUT | `/api/profile` | Обновить (age, height_cm, weight_kg, gender, ai_preferences) |
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
| `users` | Пользователи, Strava токены, физические параметры, AI настройки, премиум-статус |
| `workouts` | Тренировки из Strava, сплиты, GPS-аномалии |
| `plans` | Недельные тренировочные планы от AI |
| `goals` | Цели пользователей с дедлайнами |
| `personal_records` | Личные рекорды по дистанциям |
| `chat_messages` | История чата с AI тренером |
| `promo_codes` | Промокоды (код, длительность, лимит использований) |
| `promo_activations` | Активации промокодов пользователями |

---

**Runwise v1.1**
