require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const stravaRoutes = require('./routes/strava');
const workoutsRoutes = require('./routes/workouts');
const aiRoutes = require('./routes/ai');
const profileRoutes = require('./routes/profile');
const promoRoutes = require('./routes/promo');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

// Rate limiting

// General API limiter: 100 requests per minute per IP
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// AI endpoints: 20 requests per minute per IP (DeepSeek API costs money)
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many AI requests, please slow down' }
});

// Promo activation: 5 attempts per minute per IP (prevent brute-force)
const promoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many promo attempts, please try again later' }
});

// Auth endpoints: 10 requests per minute per IP
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth requests, please try again later' }
});

// Apply general limiter to all API routes
app.use('/api', generalLimiter);

// Routes with specific limiters
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/strava', stravaRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/ai', aiLimiter, aiRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/promo', promoLimiter, promoRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Runwise server running on port ${PORT}`);
});
