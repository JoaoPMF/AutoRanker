const queryString = require("node:querystring");
const axios = require("axios");
const express = require('express');
const session = require("express-session");
const math = require('mathjs')
require('dotenv').config();

const app = express();
app.use(session({secret: 'client-secret', resave: false, saveUninitialized: false}));
app.use(express.json());
app.use(express.urlencoded({extended: true}));

const client_id = process.env.CLIENT_ID;
const client_secret = process.env.CLIENT_SECRET;
const redirect_url = process.env.REDIRECT_URI_DECODED;
const auth_token = Buffer.from(`${client_id}:${client_secret}`, 'utf-8').toString('base64');

app.listen(8080, () => {
    console.log("App is listening on port 8080!\n");
});

app.get("/", (req, res) => {
    res.send(
        "<a href='https://accounts.spotify.com/authorize?client_id=" + client_id +
        "&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&scope=user-top-read'>Sign in</a>"
    );
});

app.get("/callback", async (req, res) => {
    const spotifyResponse = await axios.post(
        "https://accounts.spotify.com/api/token",
        queryString.stringify({
            grant_type: "authorization_code",
            code: req.query.code,
            redirect_uri: redirect_url,
        }),
        {
            headers: {
                Authorization: "Basic " + auth_token,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );
  
    req.session.context = spotifyResponse.data;
    res.redirect("/user_preference");
})

function normalizeValues(val, min, max) {
    if (min != 0 || max != 1)
        return (val - min) / (max - min); 
    return val;
} 

class TrackFeature {
    constructor (min_range, max_range) {
        this.average;
        this.weight;
        this.standard_deviation;
        this.score_values = new Array();
        this.normalized_values = new Array();
        this.min_range = min_range;
        this.max_range = max_range;
    }
}

class UserPreference {
    constructor () {
        this.danceability = new TrackFeature(0,1);
        this.energy = new TrackFeature(0,1);
        this.key = new TrackFeature(-1,11);
        this.loudness = new TrackFeature(-60,0);
        this.speechiness = new TrackFeature(0,1);
        //this.acousticness = new TrackFeature(0,1);
        //this.instrumentalness = new TrackFeature(0,1);
        //this.liveness = new TrackFeature(0,1);
        this.valence = new TrackFeature(0,1);
        this.tempo = new TrackFeature(40,180);
        this.time_signature = new TrackFeature(3,7);
        this.total_tracks = 0;
    }

    addTrackFeatures(track) {
        const properties = Object.getOwnPropertyNames(this);
        for (const property of properties) {
            if(property != "total_tracks"){
                this[property].min_range = this[property].min_range > track[property] ? track[property] : this[property].min_range;
                this[property].max_range = this[property].max_range < track[property] ? track[property] : this[property].max_range;
                this[property].normalized_values.push(normalizeValues(track[property], this[property].min_range, this[property].max_range));
            }
        }
    }

    calculateAverage() {
        const properties = Object.getOwnPropertyNames(this);
        for (const property of properties) {
            if(property != "total_tracks"){
                this[property].average = math.mean(this[property].normalized_values)
            }
        }
    }

    calculateWeight() {
        const properties = Object.getOwnPropertyNames(this);

        var sum = 0;

        for (const property of properties) {
            if(property != "total_tracks"){
                this[property].standard_deviation = math.std(this[property].normalized_values);
                sum += (1 / (1 + (this[property].standard_deviation * 10)));
            }
        }

        for (const property of properties) {
            if(property != "total_tracks"){
                this[property].weight = ((1 / (1 + (this[property].standard_deviation * 10))) / sum);
            }
        }
    }

    calculateScore(track) {
        const properties = Object.getOwnPropertyNames(this);
        var score = 0;

        for (const property of properties) {
            if(property != "total_tracks"){  
                var value = normalizeValues(track[property], this[property].min_range, this[property].max_range);
                var temp_score = (1 - Math.abs(value - this[property].average)) * this[property].weight
                this[property].score_values.push(temp_score);
                //console.log(property + " > " + temp_score.toFixed(2) + " = " + Math.abs(value - this[property].average).toFixed(2) + " * " + this[property].weight.toFixed(2));
                score += temp_score;
            }
        }

        return score;
    }

    calculateStdDevForProperties(){
        const properties = Object.getOwnPropertyNames(this);

        for (const property of properties) {
            if(property != "total_tracks"){  
                console.log(property + " - " + math.std(this[property].score_values).toFixed(3));
            }
        }
    }

    toString() {
        var string = "";
        const properties = Object.getOwnPropertyNames(this);
        for (const property of properties) {
            if(property != "total_tracks")
                string += property + " - " + this[property].min_range.toFixed(2) 
                    + " [  " + this[property].average.toFixed(2) + "  ] " 
                    + this[property].max_range.toFixed(2) + " (" + (this[property].weight * 100).toFixed(0) 
                    + "%) sd = " + this[property].standard_deviation.toFixed(2) + "</br>";
        }
        return string;
    }
}

var user_preference = new UserPreference();

app.get("/user_preference", async (req, res) => {

    var context = req.session.context;
    var ids = "";

    await axios.get(
        "https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term",
        {
            headers: {
                Authorization: "Bearer " + context.access_token,
            },
        }
    ).then((result) => {
        result.data.items.forEach(track => ids += (track.id + ","));
        ids = ids.substring(0,ids.length-1);
        user_preference.total_tracks += result.data.total;
    });

    await axios.get(
        "https://api.spotify.com/v1/audio-features?ids=" + ids,
        {
            headers: {
                Authorization: "Bearer " + context.access_token,
            },
        }
    ).then((result) => {
        result.data.audio_features.forEach(track => {
            user_preference.addTrackFeatures(track);
        });
    });

    user_preference.calculateAverage();
    user_preference.calculateWeight();
    res.send(user_preference.toString() + 
        "<form action='/rank_playlist' method='get'>" +
            "<input type='text' id='inputBox' placeholder='Enter Playlist Link'>" +
            "<input type='submit' value='Rank it for me'>" + 
        "</form>" + 
        "<script>" + 
            "let form = document.querySelector('form');" +
            "form.addEventListener('submit', (event) => {" +
                "event.preventDefault();" +
                "let inputValue = document.getElementById('inputBox').value;" +
                "form.action += '?playlistId=' + inputValue;" +
                "console.log(form.action);" + 
                "form.submit();" +
            "});" +
        "</script>"
    );
});

function printArtistDetails(artists){
    var string = "";
    for (const artist of artists){
        string += artist.name + " ";
    }
    return string;
}

app.get("/rank_playlist", async (req, res) => {
    var context = req.session.context;
    var playlist_id = req.query["playlistId"];
    console.log(playlist_id);
    var tracks = new Array();
    var ids = "";
    var list = "";

    await axios.get(
        "https://api.spotify.com/v1/playlists/" + playlist_id + "/tracks?limit=50&market=PT",
        {
            headers: {
                Authorization: "Bearer " + context.access_token,
            },
        }
    ).then((result) => {
        result.data.items.forEach(item => {
            if(item.track) {
                tracks.push(item.track);
                ids += (item.track.id + ",");
            }
        });
        ids = ids.substring(0,ids.length-1);
    });

    await axios.get(
        "https://api.spotify.com/v1/audio-features?ids=" + ids,
        {
            headers: {
                Authorization: "Bearer " + context.access_token,
            },
        }
    ).then((result) => {
        result.data.audio_features.forEach(track_features => {
            for(var track of tracks) {
                if(track.id == track_features.id){
                    track.score = user_preference.calculateScore(track_features);
                }
            }
        });
    });

    tracks.sort((a,b) => b.score - a.score);

    for(var track of tracks) {
        list += track.name + " | " + (track.artists instanceof Array ? printArtistDetails(track.artists) : track.artists.name) 
            + " - Match of " + (track.score * 100).toFixed(0) + "% </br>";
    }

    user_preference.calculateStdDevForProperties();

    res.send(list);
});


