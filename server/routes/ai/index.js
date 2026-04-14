const express = require('express');
const router = express.Router();

const chat = require('./chat');
const workout = require('./workout');
const plan = require('./plan');
const zones = require('./zones');

router.use('/', chat);
router.use('/', workout);
router.use('/', plan);
router.use('/', zones);

module.exports = router;
