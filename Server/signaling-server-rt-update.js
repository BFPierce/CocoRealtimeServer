/**********************************************************************************/
/* Original Source: https://github.com/anoek/webrtc-group-chat-example            */
/*                                                                                */
/* Modifications - CoCo Team, University of Rochester                             */
/*                                                                                */
/**********************************************************************************/

/************************************/
/* Signaling Server Setup           */
/************************************/
var PORT = 9000;

var fs = require('fs');
var uuid = require('node-uuid');

var express = require('express');
var bodyParser = require('body-parser');
var https = require('https');

var pkey = fs.readFileSync('/etc/apache2/ssl/apache.key');
var pcert = fs.readFileSync('/etc/apache2/ssl/apache.crt');

var options =
{
    key: pkey,
    cert: pcert
};

var main = express()
var server = https.createServer(options, main)
var io  = require('socket.io').listen(server);

server.listen(PORT, null, function()
{
    console.log("Listening on port " + PORT);
});

main.use(bodyParser.urlencoded({ extended: false }));
main.use(bodyParser.json());


/*************************/
/* Session Specific Data */
/*************************/
var channels = {};
var sockets = {};

// Coco Conference Session Data
var requiredUserCount = 2;

var sessions = {};
var connectedUsers = {};
var sessionStarted = {};
var uploadsFinishedCount = {};

// Each channel holds an indicator for each socket as to whether or not they are 'speaking', provided
// by the client. We can also track how many times this occurs for each socket and channel.
var interruptionDetection = {};
var interruptionCounts = {};

//var sessionKey = uuid.v1();
//var connectedUsers = 0;
//var requiredUserCount = 4;
//var sessionStarted = false;
//var uploadsFinishedCount = 0;

/**
 * Users will connect to the signaling server, after which they'll issue a "join"
 * to join a particular channel. The signaling server keeps track of all sockets
 * who are in a channel, and on join will send out 'addPeer' events to each pair
 * of users in a channel. When clients receive the 'addPeer' even they'll begin
 * setting up an RTCPeerConnection with one another. During this process they'll
 * need to relay ICECandidate information to one another, as well as SessionDescription
 * information. After all of that happens, they'll finally be able to complete
 * the peer connection and will be streaming audio/video between eachother.
 */
io.sockets.on('connection', function (socket)
{
    socket.channels = {};
    sockets[socket.id] = socket;

    console.log("["+ socket.id + "] connection accepted");

    socket.on('disconnect', function ()
	{
        for (var channel in socket.channels)
		{
            part(channel);
        }

        console.log("["+ socket.id + "] disconnected");
        delete sockets[socket.id];

		connectedUsers[channel] = connectedUsers[channel] - 1;
    });


    socket.on('join', function (config)
	{
        console.log("["+ socket.id + "] join ", config);
        var channel = config.channel;
        var userdata = config.userdata;

        if (channel in socket.channels)
		{
            console.log("["+ socket.id + "] ERROR: already joined ", channel);
            return;
        }

        if (!(channel in channels))
		{
            channels[channel] = {};

			//----------------------------------------
			// Setup this channel for CoCo
			//----------------------------------------
			sessions[channel] = uuid.v1();
			sessionStarted[channel] = false;
			connectedUsers[channel] = 0;
            uploadsFinishedCount[channel] = 0;
            interruptionCounts[channel] = {};
            interruptionDetection[channel] = {};
        }

        for (id in channels[channel])
		{
            channels[channel][id].emit('addPeer', {'peer_id': socket.id, 'should_create_offer': false});
            socket.emit('addPeer', {'peer_id': id, 'should_create_offer': true});
        }

        // Setup data structures for tracking information during the session.
        channels[channel][socket.id] = socket;
        interruptionCounts[channel][socket.id] = 0;
        interruptionDetection[channel][socket.id] = false;
        socket.channels[channel] = channel;

		//=================================================================================================
		// CoCo Join Scripting
		//=================================================================================================

		//tells this client the current session ID for this channel
		socket.emit('session_key', sessions[channel]);
		connectedUsers[channel] = connectedUsers[channel] + 1;
		console.log(channel + " currently has " + connectedUsers[channel] + " connected to it!");

        //=======================================================================================
        // IMPORTANT
        // This is the last user to connect for this channel, start the session
        // and begin handling interruption detection and broadcasting as needed.
        //=======================================================================================
		if((connectedUsers[channel] == requiredUserCount) && !sessionStarted[channel])
		{
            // Broadcast to all clients in the channel after a set delay to ensure they have
            // all booted up any dependencies before starting the analysis.
			setTimeout(function () {
				for(id in channels[channel])
					channels[channel][id].emit('session_start','start');
				sessionStarted[channel] = true;
			}, 3000);
            
            // Start a routine to keep check for interruptions, update counts, and broadcast
            // that information the the relevant users.
            setInterval(function (thisChannel) {
                let socketsSpeaking = [];

                console.log("Starting Interruption Analysis for channel " + thisChannel);

                for(id in interruptionDetection[thisChannel]) {
                    if(interruptionDetection[thisChannel][id])
                        socketsSpeaking.push(id);
                }

                console.log(socketsSpeaking);
                console.log(interruptionDetection[thisChannel]);

                // If we have more than one person speaking in this channel, let them know!
                if(socketsSpeaking.length > 1) {
                    console.log("Detected " + socketsSpeaking.length + " users speaking in channel " + thisChannel);
                    for(comSocket in channels[thisChannel]) {
                        let socketIndex = String.toString(comSocket);
                        if(socketsSpeaking.indexOf(socketIndex) > -1) {
                            interruptionCounts[thisChannel][socketIndex] = interruptionCounts[thisChannel][socketIndex] + 1;
                            channels[thisChannel][comSocket].emit('interrupt_detected', { count: interruptionCounts[thisChannel][socketIndex] });
                        }
                    }
                }

            }, 5000, channel);
		}
    });

    function part(channel)
	{
        console.log("["+ socket.id + "] part ");

        if (!(channel in socket.channels))
		{
            console.log("["+ socket.id + "] ERROR: not in ", channel);
            return;
        }

        delete socket.channels[channel];
        delete channels[channel][socket.id];

        for (id in channels[channel])
		{
            channels[channel][id].emit('removePeer', {'peer_id': socket.id});
            socket.emit('removePeer', {'peer_id': id});
        }
    }
    socket.on('part', part);

    socket.on('relayICECandidate', function(config)
	{
        var peer_id = config.peer_id;
        var ice_candidate = config.ice_candidate;
        console.log("["+ socket.id + "] relaying ICE candidate to [" + peer_id + "] ", ice_candidate);

        if (peer_id in sockets) {
            sockets[peer_id].emit('iceCandidate', {'peer_id': socket.id, 'ice_candidate': ice_candidate});
        }
    });

    socket.on('relaySessionDescription', function(config)
	{
        var peer_id = config.peer_id;
        var session_description = config.session_description;
        console.log("["+ socket.id + "] relaying session description to [" + peer_id + "] ", session_description);

        if (peer_id in sockets) {
            sockets[peer_id].emit('sessionDescription', {'peer_id': socket.id, 'session_description': session_description});
        }
    });

	//=====================================================================================================================
	// CoCo Experiment Socket Handlers
    //=====================================================================================================================
    	
	// One client has hit the 'End Call' button, let everybody in this channel know
	socket.on('propose_stop', function(config) {
		var channel = config.channel;

		if(sessionStarted[channel])	{
			sessionStarted[channel] = false;

			for(id in channels[channel])
				channels[channel][id].emit('session_end','end');
		}
    });
    
    // A Client has submitted a message that they are 'speaking' or 'not speaking'
    socket.on('speaking', function(config) {
        var channel = config.channel;
        var peer_id = config.peer_id;
        var type = config.type;

        console.log("recieved speaking message: " + config.type + " : " + config.peer_id);

        if(type === "speaking" && sessionStarted[channel])
            interruptionDetection[channel][peer_id] = true;
        else
            interruptionDetection[channel][peer_id] = false;
    });

    // Each client will tell the server when it has finished uploading video
    /*
	socket.on('upload_finished', function(config)
	{
		var peer_id = config.peer_id;
		var channel = config.channel;

		uploadsFinishedCount[channel] = uploadsFinishedCount[channel] + 1;

		if(uploadsFinishedCount[channel] == requiredUserCount)
		{
			// This client is the last to finish uploading,
			// so we'll delegate them to make the shell API call.
			sockets[peer_id].emit('shell_delegate','start analysis');
		}
    });
    */

	// Delegated client has finished with analysis, let everybody else know the
    // data page should be available.
    /*
	socket.on('analysis_complete', function(config)
	{
		var channel = config.channel;

		for(id in channels[channel])
			channels[channel][id].emit('data_available','analysis completed');
    });
    */

});