'use strict'
const express = require('express')
const axios = require('axios')
const router = express.Router()
const db = require('../models/mongodb')
const web3 = require('../models/blockchain/web3rpc')
const validator = require('../models/blockchain/validatorRpc')
const HDWalletProvider = require('truffle-hdwallet-provider')
const PrivateKeyProvider = require('truffle-privatekey-provider')
const config = require('config')
const _ = require('lodash')
const logger = require('../helpers/logger')
const { check, validationResult, query } = require('express-validator/check')
const uuidv4 = require('uuid/v4')
const urljoin = require('url-join')

const gas = config.get('blockchain.gas')
const gasPrice = config.get('blockchain.gasPrice')

router.get('/', async function (req, res, next) {
    let limit = (req.query.limit) ? parseInt(req.query.limit) : 200
    const skip = (req.query.page) ? limit * (req.query.page - 1) : 0
    if (limit > 200) {
        limit = 200
    }
    try {
        let data = await Promise.all([
            db.Candidate.find({
                smartContractAddress: config.get('blockchain.validatorAddress')
            }).sort({ capacityNumber: 'desc' }).limit(limit).skip(skip).lean().exec(),
            db.Signer.findOne({}).sort({ _id: 'desc' }),
            db.Penalty.find({}).sort({ blockNumber: 'desc' }).lean().exec()
        ])

        let candidates = data[0]
        let latestSigners = data[1]
        let latestPenalties = data[2]

        let signers = (latestSigners || {}).signers || []
        let penalties = []
        latestPenalties.forEach(p => {
            penalties = _.concat(penalties, (p || {}).penalties || [])
        })

        const setS = new Set()
        for (let i = 0; i < signers.length; i++) {
            setS.add((signers[i] || '').toLowerCase())
        }

        const setP = new Set()
        for (let i = 0; i < penalties.length; i++) {
            setP.add((penalties[i] || '').toLowerCase())
        }

        let map = candidates.map(async c => {
            // is masternode
            if (signers.length === 0) {
                c.isMasternode = !!c.latestSignedBlock
            } else {
                c.isMasternode = setS.has((c.candidate || '').toLowerCase())
            }
            // is penalty
            c.isPenalty = setP.has((c.candidate || '').toLowerCase())

            c.status = (c.isMasternode) ? 'MASTERNODE' : c.status
            c.status = (c.isPenalty) ? 'SLASHED' : c.status

            return c
        })
        let ret = await Promise.all(map)

        return res.json(ret)
    } catch (e) {
        return next(e)
    }
})

router.post('/listByHash', [
    check('hashes').exists().withMessage('Missing hashes params')
], async function (req, res, next) {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
        return next(errors.array())
    }
    let hashes = req.body.hashes
    let listHash = hashes.split(',')

    try {
        let candidates = await db.Candidate.find({ candidate: { $in: listHash } })
        return res.json(candidates)
    } catch (e) {
        logger.warn('Cannot get list candidate by hash. Error %s', e)
        return next(e)
    }
})

router.get('/crawlStatus', async function (req, res, next) {
    const limit = 200
    const skip = 0
    try {
        let candidates = await db.Candidate.find({
            smartContractAddress: config.get('blockchain.validatorAddress')
        }).sort({ capacityNumber: 'desc' }).limit(limit).skip(skip).lean().exec()

        let latestSignedBlock = 0

        for (let c of candidates) {
            latestSignedBlock = (parseInt(c.latestSignedBlock || 0) > latestSignedBlock)
                ? parseInt(c.latestSignedBlock || 0)
                : latestSignedBlock
        }

        let blockNumber = await web3.eth.getBlockNumber()

        return res.json(
            (parseInt(latestSignedBlock) > parseInt(blockNumber) - 20)
        )
    } catch (e) {
        return next(e)
    }
})

router.get('/:candidate', async function (req, res, next) {
    let address = (req.params.candidate || '').toLowerCase()
    let candidate = (await db.Candidate.findOne({
        smartContractAddress: config.get('blockchain.validatorAddress'),
        candidate: address
    }).lean().exec() || {})

    let latestSigners = await db.Signer.findOne({}).sort({ _id: 'desc' })
    let latestPenalties = await db.Penalty.find({}).sort({ blockNumber: 'desc' }).lean().exec()

    let signers = (latestSigners || {}).signers || []
    let penalties = []
    latestPenalties.forEach(p => {
        penalties = _.concat(penalties, (p || {}).penalties || [])
    })

    const setS = new Set()
    for (let i = 0; i < signers.length; i++) {
        setS.add((signers[i] || '').toLowerCase())
    }

    const setP = new Set()
    for (let i = 0; i < penalties.length; i++) {
        setP.add((penalties[i] || '').toLowerCase())
    }

    if (signers.length === 0) {
        candidate.isMasternode = !!candidate.latestSignedBlock
    } else {
        candidate.isMasternode = setS.has((candidate.candidate || '').toLowerCase())
    }

    candidate.isPenalty = setP.has((candidate.candidate || '').toLowerCase())

    candidate.status = (candidate.isMasternode) ? 'MASTERNODE' : candidate.status
    candidate.status = (candidate.isPenalty) ? 'SLASHED' : candidate.status

    return res.json(candidate)
})

router.get('/:candidate/voters', async function (req, res, next) {
    let limit = (req.query.limit) ? parseInt(req.query.limit) : 200
    const skip = (req.query.page) ? limit * (req.query.page - 1) : 0
    if (limit > 200) {
        limit = 200
    }

    let voters = await db.Voter.find({
        smartContractAddress: config.get('blockchain.validatorAddress'),
        candidate: (req.params.candidate || '').toLowerCase()
    }).limit(limit).skip(skip)
    return res.json(voters)
})
// deprecated
router.get('/:candidate/rewards', async function (req, res, next) {
    let limit = (req.query.limit) ? parseInt(req.query.limit) : 200
    const skip = (req.query.page) ? limit * (req.query.page - 1) : 0
    if (limit > 200) {
        limit = 200
    }
    let rewards = await db.MnReward.find({
        address: (req.params.candidate || '').toLowerCase()
    }).sort({ _id: -1 }).limit(limit).skip(skip)
    return res.json(rewards)
})

// for automation test only
router.post('/apply', async function (req, res, next) {
    let key = req.query.key
    let network = config.get('blockchain.rpc')
    try {
        let walletProvider =
            (key.indexOf(' ') >= 0)
                ? new HDWalletProvider(key, network)
                : new PrivateKeyProvider(key, network)

        web3.setProvider(walletProvider)
        let candidate = req.query.coinbase.toLowerCase()
        let isCandidate = await validator.methods.isCandidate(candidate).call()
        if (isCandidate) {
            await db.Candidate.updateOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate
            }, {
                $set: {
                    name: req.query.name
                }
            }, { upsert: false })
            return res.json({ status: 'OK' })
        }
        await validator.methods.propose(candidate).send({
            from : walletProvider.address,
            value: '50000000000000000000000',
            gas,
            gasPrice
        })
        if (req.query.name) {
            await db.Candidate.updateOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate
            }, {
                $set: {
                    smartContractAddress: config.get('blockchain.validatorAddress'),
                    candidate: candidate,
                    nodeId: (candidate || '').replace('0x', ''),
                    capacity: '50000000000000000000000',
                    status: 'PROPOSED',
                    owner: walletProvider.address,
                    name: req.query.name
                }
            }, { upsert: true })
        }
        return res.json({ status: 'OK' })
    } catch (e) {
        return next(e)
    }
})

// for automation test only
router.post('/applyBulk', async function (req, res, next) {
    let key = req.query.key
    let network = config.get('blockchain.rpc')
    try {
        let walletProvider =
            (key.indexOf(' ') >= 0)
                ? new HDWalletProvider(key, network)
                : new PrivateKeyProvider(key, network)

        web3.setProvider(walletProvider)
        let candidates = (req.query.candidates || '').split(',')

        for (let candidate of candidates) {
            candidate = (candidate || '').trim().toLowerCase()
            try {
                let isCandidate = await validator.methods.isCandidate(candidate).call()
                if (isCandidate) continue

                await validator.methods.propose(candidate).send({
                    from : walletProvider.address,
                    value: '50000000000000000000000',
                    gas,
                    gasPrice
                })
                if (req.query.name) {
                    await db.Candidate.updateOne({
                        smartContractAddress: config.get('blockchain.validatorAddress'),
                        candidate: candidate
                    }, {
                        $set: {
                            smartContractAddress: config.get('blockchain.validatorAddress'),
                            candidate: candidate,
                            capacity: '50000000000000000000000',
                            status: 'PROPOSED',
                            owner: walletProvider.address
                        }
                    }, { upsert: true })
                }
            } catch (e) {
                logger.error(e)
            }
        }
        return res.json({ status: 'OK' })
    } catch (e) {
        return next(e)
    }
})

// for automation test only
router.post('/resign', async function (req, res, next) {
    let key = req.query.key
    let network = config.get('blockchain.rpc')
    try {
        let walletProvider =
            (key.indexOf(' ') >= 0)
                ? new HDWalletProvider(key, network)
                : new PrivateKeyProvider(key, network)

        web3.setProvider(walletProvider)

        let candidate = req.query.coinbase.toLowerCase()
        await validator.methods.resign(candidate).send({
            from : walletProvider.address,
            gas,
            gasPrice
        })
        return res.json({ status: 'OK' })
    } catch (e) {
        return res.json({ status: 'NOK' })
    }
})

// for automation test only
router.post('/vote', async function (req, res, next) {
    let key = req.query.key
    let network = config.get('blockchain.rpc')
    try {
        let walletProvider =
            (key.indexOf(' ') >= 0)
                ? new HDWalletProvider(key, network)
                : new PrivateKeyProvider(key, network)
        let candidate = req.query.coinbase.toLowerCase()
        web3.setProvider(walletProvider)
        let ret = await validator.methods.vote(candidate).send({
            from : walletProvider.address,
            value: '500000000000000000000',
            gas,
            gasPrice
        })
        return res.json({ status: 'OK', tx: ret.transactionHash })
    } catch (e) {
        return next(e)
    }
})

// for automation test only
router.post('/unvote', async function (req, res, next) {
    let key = req.query.key
    let network = config.get('blockchain.rpc')
    try {
        let walletProvider =
            (key.indexOf(' ') >= 0)
                ? new HDWalletProvider(key, network)
                : new PrivateKeyProvider(key, network)
        let candidate = req.query.coinbase.toLowerCase()
        web3.setProvider(walletProvider)
        await validator.methods.unvote(candidate, '200000000000000000000').send({
            from : walletProvider.address,
            gas,
            gasPrice
        })
        return res.json({ status: 'OK' })
    } catch (e) {
        return res.json({ status: 'NOK' })
    }
})

router.get('/:candidate/isMasternode', async function (req, res, next) {
    try {
        let latestSigners = await db.Signer.findOne({}).sort({ _id: 'desc' })
        const signers = latestSigners.signers
        const set = new Set()
        for (let i = 0; i < signers.length; i++) {
            set.add(signers[i])
        }
        let isMasternode = (set.has(req.params.candidate || '')) ? 1 : 0

        return res.json(isMasternode)
    } catch (e) {
        return next(e)
    }
})

router.get('/:candidate/isCandidate', async function (req, res, next) {
    try {
        let isCandidate = await validator.methods.isCandidate(req.params.candidate).call()
        return res.json((isCandidate) ? 1 : 0)
    } catch (e) {
        return next(e)
    }
})

// Get masternode rewards
router.get('/:candidate/:owner/getRewards', async function (req, res, next) {
    try {
        const candidate = req.params.candidate
        const owner = req.params.owner
        const limit = 100
        const rewards = await axios.post(
            urljoin(config.get('tomoscanUrl'), 'api/expose/rewards'),
            {
                address: candidate,
                limit,
                owner: owner,
                reason: 'Voter'
            }
        )
        return res.json(rewards.data)
    } catch (e) {
        return next(e)
    }
})

// Update masternode info
router.put('/update', [
    check('name').isLength({ min: 3, max: 30 }).optional().withMessage('Name must be 3 - 30 chars long'),
    check('hardware').isLength({ min: 3, max: 30 }).optional().withMessage('Hardware must be 3 - 30 chars long'),
    check('dcName').isLength({ min: 2, max: 30 }).optional().withMessage('dcName must be 2 - 30 chars long'),
    check('dcLocation').isLength({ min: 2, max: 30 }).optional().withMessage('dcLocation must be 2 - 30 chars long')
], async function (req, res, next) {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
        return next(errors.array())
    }
    try {
        const { signedMessage, message } = req.body
        const candidate = (req.body.candidate || '').toLowerCase()
        const c = await db.Candidate.findOne({
            smartContractAddress: config.get('blockchain.validatorAddress'),
            candidate: candidate
        })
        if (!c) {
            return next(new Error('Not found'))
        }

        const body = req.body
        let set = _.pick(body, ['name', 'hardware'])

        if (body.dcName) {
            set['dataCenter.name'] = body.dcName
        }
        if (body.dcLocation) {
            set['dataCenter.location'] = body.dcLocation
        }

        const address = await web3.eth.accounts.recover(message, signedMessage)

        if (
            address.toLowerCase() === c.candidate.toLowerCase() ||
            address.toLowerCase() === c.owner.toLowerCase()
        ) {
            await db.Candidate.updateOne({
                smartContractAddress: config.get('blockchain.validatorAddress'),
                candidate: candidate.toLowerCase()
            }, {
                $set: set
            })
            await db.Signature.updateOne({
                signedAddress: address.toLowerCase()
            }, {
                $set: {
                    signature: ''
                }
            })
            return res.json({ status: 'OK' })
        } else {
            return res.json({
                error: {
                    message: 'Authentication failed'
                }
            })
        }
    } catch (e) {
        return next(e)
    }
})

router.post('/:candidate/generateMessage', [
    check('candidate').isLength({ min: 1 }).exists().withMessage('candidate is required'),
    check('account').isLength({ min: 1 }).exists().withMessage('account is required')
], async function (req, res, next) {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
        return next(errors.array())
    }
    try {
        const candidate = req.params.candidate
        const account = (req.body.account || '').toLowerCase()

        const c = await db.Candidate.findOne({
            smartContractAddress: config.get('blockchain.validatorAddress'),
            candidate: candidate
        })
        if (!c) {
            return res.status(406).send('This address is not a candidate')
        }

        const message = '[Tomomaster ' + (new Date().toLocaleString().replace(/['"]+/g, '')) + ']' +
            ' I am the owner of candidate ' + '[' + candidate + ']'
        const id = uuidv4()

        // update id, status
        const data = {
            signedId: id,
            status: true
        }
        await db.Signature.findOneAndUpdate({ signedAddress: account }, data, { upsert: true, new: true })

        return res.json({
            message,
            url: urljoin(config.get('baseUrl'), `api/candidates/verifyScannedQR?id=${id}`),
            id
        })
    } catch (error) {
        next(error)
    }
})

router.post('/verifyScannedQR', [
    query('id').exists().withMessage('id is required'),
    check('message').isLength({ min: 1 }).exists().withMessage('message is required'),
    check('signature').isLength({ min: 1 }).exists().withMessage('signature is required'),
    check('signer').isLength({ min: 1 }).exists().withMessage('signer is required'),
    check('message').isLength({ min: 1 }).exists().withMessage('message is required')
], async (req, res, next) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
        return next(errors.array())
    }
    try {
        const message = req.body.message
        const signature = req.body.signature
        const id = req.query.id
        let signer = req.body.signer.toLowerCase()

        const checkId = await db.Signature.findOne({ signedId: id })
        if (!checkId) {
            throw Error('id is not match')
        }
        if (!checkId.status) {
            throw Error('Cannot use a QR code twice')
        }

        const signedAddress = (await web3.eth.accounts.recover(message, signature) || '').toLowerCase()

        if (signer !== signedAddress || checkId.signedAddress !== signedAddress ||
            id !== checkId.signedId) {
            throw Error('The Signature Message Verification Failed')
        }

        // Store id, address, msg, signature
        const data = {}
        data.signedId = id
        data.message = message
        data.signature = signature
        data.status = false

        await db.Signature.findOneAndUpdate({ signedAddress: signedAddress }, data, { upsert: true, new: true })

        return res.send('Done')
    } catch (e) {
        console.trace(e)
        console.log(e)
        return next(e)
    }
})

router.get('/:candidate/getSignature', [
    query('id').exists().withMessage('id is required')
], async (req, res, next) => {
    const errors = validationResult(req)
    if (!errors.isEmpty()) {
        return next(errors.array())
    }
    try {
        const messId = req.query.id || ''

        const signature = await db.Signature.findOne({ signedId: messId })

        if (signature && !signature.status) {
            return res.json({
                signature: signature.signature
            })
        } else {
            return res.send({
                error: {
                    message: 'No data'
                }
            })
        }
    } catch (e) {
        next(e)
    }
})

module.exports = router
