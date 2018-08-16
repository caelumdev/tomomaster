'use strict'

var mongoose = require('mongoose')
var Schema = mongoose.Schema

var MnReward = new Schema({
    address: {
        type: String,
        index: true
    },
    owner: {
        type: String,
        index: true
    },
    checkpoint: {
        type: String,
        index: true
    },
    startBlockNumber: String,
    endBlockNumber: String,
    reward: String,
    signNumber: Number,
    totalSigners: Number
}, { timestamps: true })

module.exports = mongoose.model('MnReward', MnReward)