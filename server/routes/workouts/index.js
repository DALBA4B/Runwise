const express = require('express');
const router = express.Router();

const workouts = require('./workouts');
const goals = require('./goals');
const predictions = require('./predictions');

router.use('/', workouts);
router.use('/', goals);
router.use('/', predictions);

module.exports = router;
