# Runwise — AI Тренер для Бегунов

Веб-приложение для бегунов: синхронизация тренировок из Strava, AI-анализ, генерация планов и персональный чат с AI-тренером.

## Технологии

| Фронтенд | Бэкенд | Сервисы |
|----------|--------|---------|
| React 18 + TypeScript | Node.js + Express | Supabase (PostgreSQL) |
| Recharts (графики) | JWT авторизация | Strava API (OAuth) |
| PWA | SSE стриминг | DeepSeek API (AI) |

## Возможности

- **Strava интеграция** — OAuth авторизация, импорт тренировок и сплитов
- **AI тренер** — персональный чат со стриминг-ответами, учитывает историю тренировок, цели, физические параметры
- **Планы тренировок** — AI генерирует недельный план, можно менять прямо в чате
- **Цели** — установка целей (объём, личные рекорды) с дедлайнами и прогнозами
- **Аналитика** — статистика за неделю (пн-вс) / месяц / всё время, сравнение периодов
- **Профиль** — возраст, рост, вес для персонализации AI-рекомендаций
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
│   │   ├── screens/         # Экраны приложения
│   │   │   ├── Home.tsx         # Главная — метрики, график, AI-анализ
│   │   │   ├── History.tsx      # История тренировок по месяцам
│   │   │   ├── WorkoutDetail.tsx # Детали тренировки
│   │   │   ├── Plan.tsx         # Недельный план от AI
│   │   │   ├── AIChat.tsx       # Чат с AI тренером
│   │   │   ├── Profile.tsx      # Профиль, цели, настройки
│   │   │   └── Login.tsx        # Вход через Strava
│   │   ├── App.tsx          # Роутинг и навигация
│   │   ├── App.css          # Все стили
│   │   └── utils.ts         # Форматирование (темп, дистанция)
│   └── .env.example
├── server/                  # Express бэкенд
│   ├── routes/
│   │   ├── auth.js          # Strava OAuth + JWT
│   │   ├── strava.js        # Синхронизация тренировок
│   │   ├── workouts.js      # Тренировки, статистика, цели
│   │   ├── ai.js            # AI чат, планы, анализ
│   │   └── profile.js       # Профиль (возраст, рост, вес)
│   ├── middleware/
│   │   └── authMiddleware.js
│   ├── index.js             # Точка входа сервера
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
```

**Клиент** — скопируй `client/.env.example` → `client/.env`:

```env
REACT_APP_API_URL=http://localhost:3001
```

### 3. База данных

1. Создай проект на [supabase.com](https://supabase.com)
2. Выполни `supabase_schema.sql` в SQL Editor
3. Дополнительные миграции:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER;
ALTER TABLE users ADD COLUMN IF NOT EXISTS height_cm REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_kg REAL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sync_status TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_sync_count INTEGER;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS deadline DATE;
```

### 4. Strava OAuth

1. Зайди на [strava.com/settings/api](https://www.strava.com/settings/api)
2. Создай приложение
3. Authorization Callback Domain: `localhost` (для разработки)
4. Скопируй Client ID и Secret в `server/.env`

### 5. Запуск

```bash
# Терминал 1
cd server
npm run dev

# Терминал 2
cd client
npm start
```

Приложение откроется на http://localhost:3000

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
| GET | `/api/workouts/stats?period=week\|month\|all` | Статистика |
| GET | `/api/workouts/weekly` | Км по дням (пн-вс) |
| GET | `/api/workouts/comparison` | Сравнение этой и прошлой недели |
| GET | `/api/workouts/goals/list` | Цели |
| POST | `/api/workouts/goals` | Создать цель |
| DELETE | `/api/workouts/goals/:id` | Удалить цель |
| GET | `/api/workouts/goals/predictions` | Прогнозы целей |

### Strava
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/strava/sync` | Импорт последних 50 тренировок |
| POST | `/api/strava/sync-all` | Импорт всей истории (фон) |
| POST | `/api/strava/sync-splits` | Загрузка сплитов по км |
| GET | `/api/strava/sync-status` | Статус синхронизации |

### AI
| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/ai/chat/stream` | Стриминг чат (SSE) |
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
| PUT | `/api/profile` | Обновить (age, height_cm, weight_kg) |

## Деплой

### Фронтенд → Netlify

1. Подключи GitHub репозиторий
2. Netlify подхватит `netlify.toml` автоматически
3. Добавь переменную: `REACT_APP_API_URL=https://твой-бэкенд.up.railway.app`

### Бэкенд → Railway

1. Подключи GitHub репозиторий
2. Root Directory: `server`
3. Добавь все переменные из `server/.env`
4. Обнови:
   - `CLIENT_URL` → URL фронтенда на Netlify
   - `STRAVA_REDIRECT_URI` → URL фронтенда + `/callback`

### После деплоя

- Обнови Authorization Callback Domain в настройках Strava API
- Убедись что CORS работает между фронтом и бэком

## Дизайн

- Mobile-first, max-width 420px
- Тёмная тема (синяя палитра)
- Нижняя навигация (5 вкладок)
- CSS Custom Properties для кастомизации

---

**Runwise v1.0**
