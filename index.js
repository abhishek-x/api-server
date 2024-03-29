const express = require('express')
const { generateSlug } = require('random-word-slugs')
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')
var cors = require('cors');
require('dotenv').config()

const app = express()
const PORT = 9000

app.use(cors({origin: true, credentials: true}));

const subscriber = new Redis(process.env.REDIS_URL)
const io = new Server({ cors: '*' })

io.on('connection', socket => {
    socket.on('subscribe', channel => {
        socket.join(channel)
        socket.emit('message', `Joined: ${channel}`)
    })
})

io.listen(9001, () => {
    console.log('Socket Server running on 9001')
})

const ecsClient = new ECSClient({
    region: 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
})

const config = {
    CLUSTER: process.env.AWS_BUILD_CLUSTER,
    TASK: process.env.AWS_BUILD_TASK
}

app.use(express.json())

app.get('/', (req, res) => {
    res.send("API Server is running...")
})

app.post('/project', async (req, res) => {
    const { gitURL, slug } = req.body
    const projectSlug = slug ? slug : generateSlug()

    // Spin the container
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: ['subnet-0540a0265b9169603', 'subnet-08b108fe63178c38d', 'subnet-084d7139aed94bb4d', 'subnet-05169a3a1eaf37e30', 'subnet-0064deff83d190d94', 'subnet-041026c091858c6cb'],
                securityGroups: ['sg-0758b9e68218c20c9']
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'builder-image',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: gitURL },
                        { name: 'PROJECT_ID', value: projectSlug }
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);

    return res.json({ status: 'queued', data: { projectSlug, url: `http://${projectSlug}.localhost:8000` } })

})

async function initRedisSubscribe() {
    console.log('Subscribed to logs...')
    subscriber.psubscribe('logs:*')
    subscriber.on('pmessage', (pattern, channel, message) => {
        io.to(channel).emit('message', message)
    })
}

initRedisSubscribe()
app.listen(PORT, () => console.log(`API Server Running..${PORT}`))