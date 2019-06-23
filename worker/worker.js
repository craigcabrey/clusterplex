const STAT_CPU_INTERVAL = process.env.STAT_CPU_INTERVAL || 10000
const ORCHESTRATOR_URL = process.env.ORCHESTRATOR_URL || 'http://localhost:3500'
const TRANSCODER_PATH = process.env.TRANSCODER_PATH || '/usr/lib/plexmediaserver/'
const TRANSCODER_NAME = process.env.TRANSCODER_NAME || 'Plex Transcoder'

var socket = require('socket.io-client')(ORCHESTRATOR_URL);
var cpuStat = require('cpu-stat');
const { spawn } = require('child_process');
const uuid = require('uuid/v4');

var ON_DEATH = require('death')({debug: true})

// initialize CPU stats to a high number until it is overwritten by first sample
let cpuUsage = 9999.0;

// calculate cpu usage every 2 seconds
setInterval( () => {
    cpuStat.usagePercent({ sampleMs: STAT_CPU_INTERVAL }, (err, percent, seconds) => {
        if (!err) {
            cpuUsage = percent.toFixed(2)
        }
    });
}, STAT_CPU_INTERVAL)

let workerId = uuid()
let taskMap = new Map()

socket.on('connect', () => {
    console.log(`Worker connected on socket ${socket.id}`)
    socket.emit('worker.announce', 
    {
        workerId: workerId,
        host: process.env.HOSTNAME
    })
})

socket.on('worker.stats', cb => {
    console.log('Answering with stats to Orchestrator')
    cb({ cpu : cpuUsage, tasks: taskMap.size })
})

socket.on('worker.task.request', taskRequest => {
    console.log('Received task request')

    socket.emit('worker.task.update', {
        taskId: taskRequest.taskId,
        status: 'received'
    })

    let child = spawn(TRANSCODER_PATH + TRANSCODER_NAME, taskRequest.payload.args, {
        cwd: taskRequest.payload.cwd,
        env: taskRequest.payload.env
    });

    taskMap.set(taskRequest.taskId, child)

    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);

    let notified = false
    const completionHandler = (code) => {
        if (!notified) {
            console.log('Completed transcode')
            socket.emit('worker.task.update', { taskId: taskRequest.taskId, status: 'done', result: code === 0, exitCode : code })
            notified = true
            console.log('Removing process from taskMap')
            taskMap.delete(taskRequest.taskId)
        }
    }

    child.on('error', (err) => {
        console.error('Transcoding failed:')
        console.error(err)
        notified = true
        socket.emit('worker.task.update', { taskId: taskRequest.taskId, status: 'done', result: false, error: err.message })
        console.log('Orchestrator notified')

        console.log('Removing process from taskMap')
        taskMap.delete(taskRequest.taskId)
    })
    
    child.on('close', completionHandler)
    child.on('exit', completionHandler)

    socket.emit('worker.task.update', {
        taskId: taskRequest.taskId,
        status: 'inprogress'
    })
})

socket.on('worker.task.kill', data => {
    let taskEntry = taskMap.get(data.taskId)
    if (taskEntry) {
        console.log(`Killing child process for task ${data.taskId}`)
        taskEntry.kill()
        console.log('Removing process from taskMap')
        taskMap.delete(data.taskId)
    }
})

socket.on('disconnect', () => {
    console.log('Worker disconnected')
})

ON_DEATH( (signal, err) => {
    console.log('ON_DEATH signal detected')
    console.error(err)
    process.exit(signal)
})

