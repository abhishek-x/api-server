require('dotenv').config()
const express = require('express')
const bodyParser = require('body-parser');
const { generateSlug } = require('random-word-slugs')
const AWS = require('aws-sdk');
const { ECSClient, RunTaskCommand } = require('@aws-sdk/client-ecs')
const { Server } = require('socket.io')
const Redis = require('ioredis')
var cors = require('cors');

const app = express()
const PORT = 9000

app.use(cors({ origin: true, credentials: true }));
app.use(bodyParser.json());

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

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();

// Function to check bucket availability
async function checkBucketAvailability(bucketName) {
    try {
        await s3.headBucket({ Bucket: bucketName }).promise();
        // If no error, bucket exists
        return false;
    } catch (error) {
        if (error.statusCode === 404) {
            // Bucket does not exist
            return true;
        }
        // Other errors (e.g., forbidden access)
        throw error;
    }
}

// Function to generate a unique bucket name
async function generateUniqueBucketName() {
    let available = false;
    let bucketName;
    while (!available) {
        bucketName = generateSlug();
        available = await checkBucketAvailability(bucketName);
    }
    return bucketName;
}

// Function to turn off Block Public Access settings for the bucket
async function disableBlockPublicAccess(bucketName) {
    const params = {
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
            // Set all four options to false to disable block public access
            BlockPublicAcls: false,
            IgnorePublicAcls: false,
            BlockPublicPolicy: false,
            RestrictPublicBuckets: false
        }
    };

    try {
        await s3.putPublicAccessBlock(params).promise();
        console.log(`Block Public Access settings turned off for ${bucketName}`);
    } catch (error) {
        console.error('Error disabling Block Public Access:', error);
        throw error; // Rethrow the error for further handling
    }
}

// Function to set public read access on the bucket
async function setBucketPolicyForPublicReadAccess(bucketName) {
    const policy = {
        Version: "2012-10-17",
        Statement: [{
            Sid: "PublicReadGetObject",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: `arn:aws:s3:::${bucketName}/*`
        }]
    };

    await s3.putBucketPolicy({
        Bucket: bucketName,
        Policy: JSON.stringify(policy),
    }).promise();
}

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
    const { gitURL } = req.body
    // const projectSlug = slug ? slug : generateSlug()

    // Create a new S3 bucket configured for static website hosting
    const bucketName = await generateUniqueBucketName();
    await s3.createBucket({ Bucket: bucketName }).promise();

    const staticHostParams = {
        Bucket: bucketName,
        WebsiteConfiguration: {
            ErrorDocument: {
                Key: 'error.html',
            },
            IndexDocument: {
                Suffix: 'index.html',
            },
        },
    };

    await s3.putBucketWebsite(staticHostParams).promise();
    await disableBlockPublicAccess(bucketName);
    await setBucketPolicyForPublicReadAccess(bucketName);

    // Spin the container
    const command = new RunTaskCommand({
        cluster: config.CLUSTER,
        taskDefinition: config.TASK,
        launchType: 'FARGATE',
        count: 1,
        networkConfiguration: {
            awsvpcConfiguration: {
                assignPublicIp: 'ENABLED',
                subnets: ['subnet-082b82a29a054e11a', 'subnet-0f12d8bddde47477e', 'subnet-0fd482501205310c9', 'subnet-0470b824371f55363', 'subnet-04e3b60b1ab3ff862', 'subnet-0ab57e8aa37a8de33'],
                securityGroups: ['sg-076de8251bbfcf339']
            }
        },
        overrides: {
            containerOverrides: [
                {
                    name: 'build-image',
                    environment: [
                        { name: 'GIT_REPOSITORY__URL', value: gitURL },
                        { name: 'PROJECT_ID', value: bucketName }
                    ]
                }
            ]
        }
    })

    await ecsClient.send(command);

    return res.json(
        { 
            status: 'queued', 
            data: { 
                projectSlug: bucketName, 
                url: `http://${bucketName}.s3-website.${process.env.AWS_REGION}.amazonaws.com` 
            } 
        }
    )
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