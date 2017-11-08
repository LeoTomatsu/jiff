var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var cryptico = require('cryptico');
var jiff = require('./tests/jiff-client/jiff.js').jiff;


// Server static files
app.use(express.static("tests"));

// The modulos to be used in secret sharing and operations on shares.
var Zp = 2081;

var socket_map = {'1':{},'2':{},'3':{}};// map of maps [computation id][party id] = socket id

var party_map = {};// socket.id -> party_id
var computation_map = {}; // socket.id -> computation_id

var client_map = {'1': 0}; //total number of parties per computation
var totalparty_map = {'1': 3}; //max number of parties per computation

var key_map = {};// public key map
var triplets_map = {};
var numbers_map = {};

var establish_server_connections = false;
var server_side_jiff_instances = {'1':[]};

io.on('connection', function(socket) {
  console.log('user connected');

  // Receive each user's desired computation
  socket.on('computation_id', function(msg) {
    msg = JSON.parse(msg);
    
    // read message
    var computation_id = msg['computation_id'];
    var party_id = msg['party_id'];
    var party_count = msg['party_count'];
    
    if(client_map[computation_id] == null) client_map[computation_id] = 0;
    if(socket_map[computation_id] == null) socket_map[computation_id] = {};
    
    if(party_id == null) party_id = ++(client_map[computation_id]);
    if(party_count == null) party_count = totalparty_map[computation_id];

    
    // no party count given or saved.
    if(party_count == null) {
      io.to(socket.id).emit('error', "party count is not specified nor pre-saved");
    }
    
    // given party count contradicts the count that is already saved.
    else if(totalparty_map[computation_id] != null && party_count != totalparty_map[computation_id]) {
      io.to(socket.id).emit('error', "contradicting party count");
    }
    
    // given party id is already claimed by someone else.
    else if(socket_map[computation_id][party_id] != null) {
      io.to(socket.id).emit('error', party_id + " is already taken");
    }
    
    else if(isNaN(party_id) || party_id <= 0) {
      io.to(socket.id).emit('error', "Invalid party ID");      
    }
    
    else if(party_id > party_count) {
      io.to(socket.id).emit('error', "Maximum parties capacity reached");
    }
    
    else {      
      totalparty_map[computation_id] = party_count;
      socket_map[computation_id][party_id] = socket.id;
      computation_map[socket.id] = computation_id;
      party_map[socket.id] = party_id;

      io.to(socket.id).emit('init', JSON.stringify({ party_id: party_id, party_count: party_count }));
    }

    // if this flag is turned on, establish jiff instances server-side
    // to enable instant connections
    if (msg.establish_server_connections == true) {
      console.log("connect server side");
      establish_server_connections = true;

      // calculate how many server-side clients we need
      var server_side_clients = totalparty_map[computation_id] - client_map[computation_id]
      
      if (server_side_clients > 0){
        console.log("creating " + server_side_clients + " server-side clients");
        server_side_jiff_instances[computation_id] = [];
        for (var i = 0; i < server_side_clients; i++){
          var jiff_instance = jiff.make_jiff("http://localhost:3000", computation_id, {"computation_id":computation_id,"party_count":msg.party_count});
          server_side_jiff_instances[computation_id].push(jiff_instance);
        }
      }
    }
  });

  // Receive each user's public key
  socket.on('public_key', function(msg) {
    var party_id = party_map[socket.id];
    var computation_id = computation_map[socket.id];

    // store public key in key_map
    var tmp = key_map[computation_id];
    if(tmp == null) tmp = {};
    tmp[party_id] = msg;
    key_map[computation_id] = tmp;

    // Check if all public keys for this computation are received
    var full = true;
    for(var i = 1; i <= totalparty_map[computation_id]; i++) {
      if(key_map[computation_id][i] == null) {
        full = false;
        break;
      }
    }

    // If everyone sent their public key, emit all the keys to everyone
    if(full) {
      io.emit('public_key', JSON.stringify(key_map[computation_id]));
    }
  });

  socket.on('disconnect', function() {
    console.log('user disconnected');
    try {
      var computation_id = computation_map[socket.id];
      var party_id = party_map[socket.id];

      party_map[socket.id] = null;
      computation_map[socket.id] = null;
      socket_map[computation_id][party_id] = null;
      key_map[computation_id][party_id] = null;
    } catch(ex) { }
  });

  socket.on('share', function(msg) {
    var computation_id = computation_map[socket.id];
    var from_id = party_map[socket.id];

    console.log('share from ' + computation_id + "-" + from_id + ' : ' + msg);

    var json_msg = JSON.parse(msg);
    var to_id = json_msg["party_id"];
    json_msg["party_id"] = from_id;

    io.to(socket_map[computation_id][to_id]).emit('share', JSON.stringify(json_msg));

    if (establish_server_connections == true){
      shareServerSideInstances(computation_id);
    }
  });

  socket.on('open', function(msg) {
    var computation_id = computation_map[socket.id];
    var from_id = party_map[socket.id];

    console.log('open from ' + computation_id + "-" + from_id + ' : ' + msg);

    var json_msg = JSON.parse(msg);
    var to_id = json_msg["party_id"];
    json_msg["party_id"] = from_id;

    io.to(socket_map[computation_id][to_id]).emit('open', JSON.stringify(json_msg));
  });
  
  // Triplet count is like a program counter for triplets, to ensure all 
  // parties get matching shares of the same triplet.
  socket.on('triplet', function(msg) {
    msg = JSON.parse(msg);
    var triplet_id = msg.triplet_id;
    var Zp = msg.Zp;
    
    var computation_id = computation_map[socket.id];
    var from_id = party_map[socket.id];
    
    console.log('triplet ' + triplet_id + ' from ' + computation_id + "-" + from_id + ' Zp ' + Zp);
    
    if(triplets_map[computation_id] == null) 
      triplets_map[computation_id] = {};
      
    var all_triplets = triplets_map[computation_id];  
    if(all_triplets[triplet_id] == null) { // Generate Triplet.
      var a = Math.floor(Math.random() * Zp);
      var b = Math.floor(Math.random() * Zp);
      var c = mod(a * b, Zp);
      
      var a_shares = jiff_compute_shares(a, totalparty_map[computation_id], Zp);
      var b_shares = jiff_compute_shares(b, totalparty_map[computation_id], Zp);
      var c_shares = jiff_compute_shares(c, totalparty_map[computation_id], Zp);
      
      var triplet_shares = {};
      for(var i = 1; i <= totalparty_map[computation_id]; i++) {
        // Encrypt and store shares
        var pkey = key_map[computation_id][i];
        var a = cryptico.encrypt(a_shares[i].toString(10), pkey).cipher;
        var b = cryptico.encrypt(b_shares[i].toString(10), pkey).cipher;
        var c = cryptico.encrypt(c_shares[i].toString(10), pkey).cipher;
        
        triplet_shares[i] = { a: a, b: b, c: c };
      }
      
      all_triplets[triplet_id] = triplet_shares;
    }    
    
    var triplet_msg = { triplet: all_triplets[triplet_id][from_id], triplet_id: triplet_id };
    io.to(socket_map[computation_id][from_id]).emit('triplet', JSON.stringify(triplet_msg));
  });
  
  // Triplet count is like a program counter for triplets, to ensure all 
  // parties get matching shares of the same triplet.
  socket.on('number', function(msg) {
    msg = JSON.parse(msg);
    var number_id = msg.number_id;
    var Zp = msg.Zp;
    var bit = msg.bit;
    var nonzero = msg.nonzero;
    var max = msg.max;
    if(max == null) max = Zp;
    
    var computation_id = computation_map[socket.id];
    var from_id = party_map[socket.id];
    
    console.log('number ' + number_id + ' from ' + computation_id + "-" + from_id + ' Options ' + JSON.stringify(msg));
    
    if(numbers_map[computation_id] == null) 
      numbers_map[computation_id] = {};
      
    var all_numbers = numbers_map[computation_id];  
    if(all_numbers[number_id] == null) { // Generate shares for number.
      var number = Math.floor(Math.random() * max);
      
      if(msg.number != null) number = msg.number;
      else if(bit === true && nonzero === true) number = 1;
      else if(bit == true) number = number % 2;
      else if(nonzero == true && number == 0) number = Math.floor(Math.random() * (max-1)) + 1;
      
      // Compute shares
      var shares = jiff_compute_shares(number, totalparty_map[computation_id], Zp);
      
      // Encrypt and store shares
      for(var i = 1; i <= totalparty_map[computation_id]; i++) {
        var pkey = key_map[computation_id][i];
        shares[i] = cryptico.encrypt(shares[i].toString(10), pkey).cipher;
      }
      all_numbers[number_id] = shares;
    }
    
    var number_msg = { number: all_numbers[number_id][from_id], number_id: number_id };
    io.to(socket_map[computation_id][from_id]).emit('number', JSON.stringify(number_msg));
  });
});

http.listen(3000, function(){
  console.log('listening on *:3000');
});

// Mod instead of javascript's remainder (%)
function mod(x, y) {
  if (x < 0) {
      return ((x%y)+y)%y;
    }

  return x%y;
}

/*
 * Compute the shares of the secret (as many shares as parties) using
 * a polynomial of degree: ceil(parties/2) - 1 (honest majority).
 *   secret:        the secret to share.
 *   party_count:   the number of parties.
 *   Zp:            the modulos.
 *   return:        a map between party number (from 1 to parties) and its
 *                  share, this means that (party number, share) is a
 *                  point from the polynomial.
 *
 */
function jiff_compute_shares(secret, party_count, Zp) {
  var shares = {}; // Keeps the shares

  // Each player's random polynomial f must have
  // degree t = ceil(n/2)-1, where n is the number of players
  // var t = Math.floor((party_count-1)/ 2);
  var t = party_count - 1;
  var polynomial = Array(t+1); // stores the coefficients

  // Each players's random polynomial f must be constructed
  // such that f(0) = secret
  polynomial[0] = secret;

  // Compute the random polynomial f's coefficients
  for(var i = 1; i <= t; i++) polynomial[i] = Math.floor(Math.random() * Zp);

  // Compute each players share such that share[i] = f(i)
  for(var i = 1; i <= party_count; i++) {
    shares[i] = polynomial[0];
    power = i;

    for(var j = 1; j < polynomial.length; j++) {
      shares[i] = mod((shares[i] + polynomial[j] * power), Zp);
      power = power * i;
    }
  }

  return shares;
}

function shareServerSideInstances(computation_id){
    var total_instances = server_side_jiff_instances[computation_id].length
    for(var i = 0; i < total_instances; i++){
      server_side_jiff_instances[computation_id][i].generate_and_share_zero();
    }
  }
