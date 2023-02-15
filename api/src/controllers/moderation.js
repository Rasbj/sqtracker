import fetch from 'node-fetch'
import Report from '../schema/report'
import Torrent from '../schema/torrent'
import User from '../schema/user'
import Progress from '../schema/progress'
import Invite from '../schema/invite'
import Request from '../schema/request'
import Comment from '../schema/comment'

export const createReport = async (req, res) => {
  if (req.body.reason) {
    try {
      const torrent = await Torrent.findOne({
        infoHash: req.params.infoHash,
      }).lean()

      if (!torrent) {
        res.status(404).send('Torrent with that info hash does not exist')
        return
      }

      const report = new Report({
        torrent: torrent._id,
        reportedBy: req.userId,
        reason: req.body.reason,
        solved: false,
        created: Date.now(),
      })

      await report.save()
      res.sendStatus(200)
    } catch (e) {
      res.status(500).send(e.message)
    }
  } else {
    res.status(400).send('Request must include reason')
  }
}

export const fetchReport = async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      res.status(401).send('You do not have permission to view a report')
      return
    }

    const report = await Report.findOne({ _id: req.params.reportId }).lean()

    if (!report) {
      res.status(404).send('Report could not be found')
      return
    }

    report.reportedBy = await User.findOne({ _id: report.reportedBy }).select(
      'username created'
    )
    report.torrent = await Torrent.findOne({ _id: report.torrent }).select(
      'name description infoHash created'
    )

    res.json(report)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const getReports = async (req, res) => {
  const pageSize = 25
  try {
    if (req.userRole !== 'admin') {
      res.status(401).send('You do not have permission to view reports')
      return
    }

    let { page } = req.query
    page = parseInt(page) || 0
    const reports = await Report.aggregate([
      {
        $match: { solved: false },
      },
      {
        $sort: { created: -1 },
      },
      {
        $skip: page * pageSize,
      },
      {
        $limit: pageSize,
      },
      {
        $lookup: {
          from: 'users',
          as: 'reportedBy',
          let: { userId: '$reportedBy' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$userId'] } },
            },
            {
              $project: {
                username: 1,
              },
            },
          ],
        },
      },
      {
        $lookup: {
          from: 'torrents',
          as: 'torrent',
          let: { torrentId: '$torrent' },
          pipeline: [
            {
              $match: { $expr: { $eq: ['$_id', '$$torrentId'] } },
            },
            {
              $project: {
                name: 1,
              },
            },
          ],
        },
      },
      {
        $unwind: {
          path: '$reportedBy',
          preserveNullAndEmptyArrays: true,
        },
      },
      {
        $unwind: {
          path: '$torrent',
          preserveNullAndEmptyArrays: true,
        },
      },
    ])
    res.json(reports)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const setReportResolved = async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      res.status(401).send('You do not have permission to resolve a report')
      return
    }

    await Report.findOneAndUpdate(
      { _id: req.params.reportId },
      { $set: { solved: true } }
    )

    res.sendStatus(200)
  } catch (e) {
    res.status(500).send(e.message)
  }
}

export const getStats = async (req, res) => {
  try {
    if (req.userRole !== 'admin') {
      res.status(401).send('You do not have permission to view tracker stats')
      return
    }

    const registeredUsers = await User.countDocuments()
    const bannedUsers = await User.countDocuments({ banned: true })
    const uploadedTorrents = await Torrent.countDocuments()
    const completedDownloads = await Progress.countDocuments({ left: 0 })
    const totalInvitesSent = await Invite.countDocuments()
    const invitesAccepted = await Invite.countDocuments({ claimed: true })
    const totalRequests = await Request.countDocuments({})
    const filledRequests = await Request.countDocuments({
      fulfilledBy: { $exists: true },
    })
    const totalComments = await Comment.countDocuments()

    const statsData = {
      registeredUsers,
      bannedUsers,
      uploadedTorrents,
      completedDownloads,
      totalInvitesSent,
      invitesAccepted,
      totalRequests,
      filledRequests,
      totalComments,
    }

    try {
      const trackerRes = await fetch(`${process.env.SQ_TRACKER_URL}/stats`)

      if (!trackerRes.ok) {
        const body = await trackerRes.text()
        throw new Error(
          `Error performing tracker scrape: ${trackerRes.status} ${body}`
        )
      }

      const body = await trackerRes.text()
      const [peers, seeds, activeTorrentsLine] = body.split('\n')

      const leechers = parseInt(peers) - parseInt(seeds)

      const activeTorrentsRegex = /opentracker serving ([0-9]+) torrents/
      const [, activeTorrents] = activeTorrentsLine.match(activeTorrentsRegex)

      res.json({ ...statsData, peers, seeds, leechers, activeTorrents })
    } catch (e) {
      console.error('[DEBUG] Error: could not fetch stats from tracker')
      res.json({
        ...statsData,
        peers: '?',
        seeds: '?',
        leechers: '?',
        activeTorrents: '?',
      })
    }
  } catch (e) {
    res.status(500).send(e.message)
  }
}
