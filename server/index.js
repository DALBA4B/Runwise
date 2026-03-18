require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const stravaRoutes = require('./routes/strava');
const workoutsRoutes = require('./routes/workouts');
const aiRoutes = require('./routes/ai');
const profileRoutes = require('./routes/profile');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/strava', stravaRoutes);
app.use('/api/workouts', workoutsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/profile', profileRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Runwise server running on port ${PORT}`);
});
