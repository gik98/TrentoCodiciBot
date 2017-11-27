/*
*    OpenMove - CodiciBot
*    Giacomo Fabris - Nov 2017
*    
*    This program is free software: you can redistribute it and/or modify
*    it under the terms of the GNU General Public License as published by
*    the Free Software Foundation, either version 3 of the License, or
*    (at your option) any later version.
*
*    This program is distributed in the hope that it will be useful,
*    but WITHOUT ANY WARRANTY; without even the implied warranty of
*    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
*    GNU General Public License for more details.
*
*    You should have received a copy of the GNU General Public License
*    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/


const mongoose = require("mongoose");
const Telegraf = require("telegraf");

//Regular Expressions
const bus_regex = /^(\d){3,4}$/;
const openmove_regex = /^TT\d{3,4}$/;
const train_regex = /^(ora|primolano|ala|avio|borghetto|borgo est|borgo|calceranica|caldonazzo|grigno|lavis|levico|mezzocorona borgata|mori|pergine|povo|rovereto|cristoforo|serravalle|scrigno|grigno|trento nord|trento bartolameo|trento chiara|villazzano|trento|gardolo|zona industriale|lamar|zambana|nave|grumo|mezzocorona|mezzolombardo|masi|crescino|denno|mollaro|segno|taio|dermulo|tassullo|cles polo|cles|mostizzolo|bozzana|tozzaga|cassana|cavizzana|caldes|terzolas|malè|croviana|monclassico|dimaro|mastellina|daolasa|piano|marileva|mezzana)$/i;
const ropeway_trento_regex = /^funivia trento$/i;
const ropeway_sardagna_regex = /^funivia sardagna$/i;

//DB connection
if (process.env.MONGODB_USER)
	mongoose.connect("mongodb://"+process.env.MONGODB_USER + ":" + process.env.MONGODB_PASSWORD + "@localhost/" + (process.env.MONGODB_DATABASE ? process.env.MONGODB_DATABASE : "codicibot"));

else
	mongoose.connect("mongodb://localhost/codicibot");

mongoose.connection.on('error', console.error.bind(console, 'connection error:'));
mongoose.connection.once('open', function() {
	console.log("DB connection open");
});

//DB Schema
let CodesSchema = mongoose.Schema({
	openmove: {type: String, match: openmove_regex},		//Openmove code
	vehicle: {type: String, enum: ["bus", "ropeway", "train"]},	//Vehicle type
	vehicleName: String,						//Vehicle name (i.e., train station name | bus code | ... )
	persist: {type: Boolean, default: false},			//Persistent codes cannot be crowd-edited
	confirms: {type: Number, default: 0, min: 0},			//No. of confirms this code received from the users
	user: String							//Creator of this code
}, {timestamps: true});							//Timestamps (updatedAt & createdAt)

let Code = mongoose.model("code", CodesSchema);

//Crowdsourcing set-up
const confidence = (process.env.CONFIDENCE ? process.env.CONFIDENCE : 2);			//codes with confirms < confidence are returned to user queries
const time_interval = (process.env.TIME_INTERVAL ? process.env.TIME_INTERVAL : 3600000);	//grace time between confirm increases
let superusers = [];
if (process.env.SUPERUSERS)
	superusers = process.env.SUPERUSERS.split(";");

//===========BOT==================
//setup

/*
Bot interaction are stateful. (Actually, it is only code feeding) 
0/none	=> standard mode
1	=> Insertion mode: vehicle name
2	=> Insertion mode: OpenMove code (train)
3	=> Insertion mode: OpenMove code (bus)
*/
let states = {};
//tmp_names holds temporary variables between states.
let tmp_names = {};

const bot = new Telegraf(process.env.BOT_TOKEN);
const help = "Questo bot ti fornisce i codici dei mezzi pubblici in Trentino utilizzabili con gli abbonamenti OpenMove.\nCome funziona: \n(i) BUS: mandami un messaggio contenente il numero del bus (puoi leggerlo, ad esempio, sul paraurti anteriore, sulla fiancata o sul retro del mezzo), il bot ti restituirà il codice.\n(ii)Treno: mandami un messaggio con il nome della stazione\n(iii)Funivia Trento-Sardagna: invia 'funivia trento' per il codice della stazione a valle, 'funivia sardagna' per il codice della stazione a monte.\n\nAiutaci ad ampliare la collezione di codici! Segnala codici non presenti o errati utilizzando il comando /feed\nDisclaimer: questo bot è stato creato da uno sviluppatore terzo, e non è in nessun modo dipendente da OpenMove, Trentino Trasporti o altri fornitori del servizio di trasporto pubblico. Lo sviluppatore non si assume nessuna responsabilità sulla correttezza dei dati inseriti dagli utenti.\nQuesto bot è software libero! Puoi contribuire allo sviluppo, segnalare bug, fare quello che ti pare al seguente link: https://github.com/gik98/TrentoCodiciBot";
bot.start(ctx => {
	console.log("Started: ", ctx.from.id);
	return ctx.reply("Ciao!\n" + help);
});

bot.catch(err => {
	console.log(err);
});

//middleware: avoid bots
bot.use((ctx, next) => {
	if (ctx.from.is_bot)
		return ctx.reply("No bot allowed!");
	return next(ctx);
});	

bot.command("help", ctx => {ctx.reply(help)});

bot.command("feed", ctx => {
	ctx.reply("Vuoi inserire un codice? Dimmi il numero del bus o il nome della stazione");
	states[ctx.from.id] = 1;
});

//reply to query
function handleResponse(ctx){
	return (err, doc) => {
		if (err){
	        	console.log (err);
	                return ctx.reply("Errore interno.");
	        } else if (doc.length === 0)
	         	return ctx.reply("Non conosco il codice di questo mezzo. Ehi, potresti dirmelo tu!");
	        else{
	        	let str = "";
			return doc.forEach(elem => {
				ctx.reply(elem.openmove);
			});
	        }
	}
}

//insert code
function handleInsert(ctx, vehicle, vehicleName, code){
	//flush state info
	delete states[ctx.from.id];
	delete tmp_names[ctx.from.id];
	//match code regex
	code = code.toUpperCase();
	let openmove = code.match(openmove_regex);
	if (!openmove || openmove.length === 0)
		return ctx.reply("Codice non valido!");
	openmove = openmove[0];
	//search if code exists
	Code.find({
		"openmove": openmove
	}, (err, doc) => {
		if (err) {
                	ctx.reply("Errore interno :(");
                        return console.log(err);
		}
                if (!doc || doc.length === 0){
			//code does not exist - insert doc
                	let d = {
				"openmove": openmove,
				"vehicle": vehicle,
				"vehicleName": vehicleName,
				"user": ctx.from.id,
				"confirms": 1
			};
			if (superusers.indexOf(ctx.from.username) !== -1)
				d.persist = true;
			return Code.create(d, (err, doc) => {
				if (err){
					console.log(err);
					return ctx.reply("Errore interno :(");
				}
				return ctx.reply("Grazie! Il tuo contributo è stato registrato");
			})
                } else {
			/*
			Doc already exists.
			If doc is persistent, do nothing. If not:
			If code matches and the last update occoured less than 1 hour ago, confirms += 1
			If it does not, confirms -=1. If confirms < 0; edit code also
			Edits coming from superusers are always accepted and promote the target code to persistent
			*/
			if (superusers.indexOf(ctx.from.username) === -1){
				if (doc[0].persist)
					return ctx.reply("Grazie");	//ignore
			
				else if (doc[0].vehicle === vehicle && doc[0].vehicleName === vehicleName)
                        	        if (new Date() > new Date(doc[0].updatedAt.getTime() + time_interval))
                                	        doc[0].confirms++;
                        	else {
                                	doc[0].confirms--;
                                	if (doc[0].confirms < 0){
                                        	doc[0].confirms = 0;
                                        	doc[0].vehicleName = vehicleName;
                                        	doc[0].vehicle = vehicle;
                                	}
                        	}
			} else {
				doc[0].persist = true;
				doc[0].vehicle = vehicle;
				doc[0].vehicleName = vehicleName;
			}		
	

			doc[0].save((err, doc) => {
				if (err){
					console.log(err);
					return ctx.reply("Errore interno :(");
				}
				return ctx.reply("Grazie! Il tuo contributo è stato registrato");
			});
                }
	});
}

//Read user input
bot.on("text", ctx => {
	let m;							//m stores the regex match
	if (states[ctx.from.id] === 1){ 			//state 1: insert vehicle name
		m = ctx.message.text.match(train_regex);
		if (m){						//It's a train station
			states[ctx.from.id] = 2;
			tmp_names[ctx.from.id] = m[0];
			return ctx.reply("OK. Dimmi il codice openmove della stazione di " + m[0]);
		}
		m = ctx.message.text.match(bus_regex);
		if (m){						//It's a bus
			states[ctx.from.id] = 3;
			tmp_names[ctx.from.id] = m[0];
			return ctx.reply("OK. Dimmi il codice openmove del bus " + m[0]);
		}
		return ctx.reply("Fa lo stesso :D");
	} else if (states[ctx.from.id] === 2) {			//State 2: OpenMove code :: train
		return handleInsert(ctx, "train", tmp_names[ctx.from.id], ctx.message.text);
	} else if (states[ctx.from.id] === 3){			//State 3: OpenMove code :: bus
		return handleInsert(ctx, "bus", tmp_names[ctx.from.id], ctx.message.text);
	} else {							//We're in state 0: code query
		m = ctx.message.text.match(ropeway_trento_regex);	//Match ropeways first
		if (m){
			return Code.find({
				"vehicle": "ropeway",
				"vehicleName": m[0].toLowerCase(),
				"$or": [
					{"confirms": {$gte: confidence}},
					{"persist": true}
				]	
			}, handleResponse(ctx));
		}
		m = ctx.message.text.match(ropeway_sardagna_regex);
		if (m){
			return Code.find({
				"vehicle": "ropeway",
				"vehicleName": m[0].toLowerCase(),
				"$or": [
                                        {"confirms": {$gte: confidence}},
                                        {"persist": true}
                                ]
			}, handleResponse(ctx)); 
		}
		m = ctx.message.text.match(bus_regex);			//Match busses
		if (m){
			return Code.find({
				"vehicle": "bus",
				"vehicleName": m[0],
				"$or": [
                                        {"confirms": {$gte: confidence}},
                                        {"persist": true}
                                ]
			}, handleResponse(ctx));
		}
		m = ctx.message.text.match(train_regex);		//Match train stations
		if (m){
			return Code.find({
				"vehicle": "train",
				"vehicleName": {$regex: new RegExp("^" + m[0] + "$", "i")},
				"$or": [
                                        {"confirms": {$gte: confidence}},
                                        {"persist": true}
                                ]
			}, handleResponse(ctx));
		} else
			ctx.reply("Non capisco :(\nSe stai cercando una stazione, prova ad usare meno parole. Ad esempio, usa 'Borgo' per Borgo Valsugana Centro, 'borgo est' per Borgo Valsugana Est");
	}
});

bot.startPolling();

console.log("Server up");

