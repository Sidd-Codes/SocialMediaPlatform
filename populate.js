const color_start = '\x1b[33m%s\x1b[0m'; // yellow
const color_success = '\x1b[32m%s\x1b[0m'; // green
const color_error = '\x1b[31m%s\x1b[0m'; // red

console.log(color_start, 'Started populate.js script...');

const async = require('async');
const Actor = require('./models/Actor.js');
const Script = require('./models/Script.js');
const Notification = require('./models/Notification.js');
const _ = require('lodash');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const CSVToJSON = require("csvtojson");

// Input Files
const actor_inputFile = './input/actors.csv';
const posts_inputFile = './input/posts.csv';
const notifications_inputFile = './input/notifications (read, like).csv';
const notifications_replies_inputFile = './input/notifications (reply).csv';

let actors_list;
let posts_list;
let comment_list;
let notification_list;
let notification_reply_list;

dotenv.config({ path: '.env' });

const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

mongoose.connect(process.env.MONGODB_URI || process.env.MONGOLAB_URI, { useNewUrlParser: true });
const db = mongoose.connection;

mongoose.connection.on('error', (err) => {
    console.error(err);
    console.log(color_error, '%s MongoDB connection error. Please make sure MongoDB is running.');
    process.exit(1);
});

async function getRandomActor() {
    const randomIndex = Math.floor(Math.random() * actors_list.length);
    return actors_list[randomIndex].username;
}

async function generateAIComment(postContent) {
    try {
        const response = await openai.Completion.create({
            model: 'text-davinci-002',
            prompt: `Generate a comment for a post: "${postContent}"`,
            max_tokens: 50
        });
        return response.choices[0].text.trim();
    } catch (error) {
        console.error("Error generating AI comment:", error);
        return "Nice post!";
    }
}

async function doPopulate() {
    let promise = new Promise((resolve, reject) => { // Drop the actors collection
        console.log(color_start, "Dropping actors...");
        db.collections['actors'].drop(function(err) {
            console.log(color_success, 'Actors collection dropped');
            resolve("done");
        });
    }).then(() => { // Drop the scripts collection
        return new Promise((resolve, reject) => {
            console.log(color_start, "Dropping scripts...");
            db.collections['scripts'].drop(function(err) {
                console.log(color_success, 'Scripts collection dropped');
                resolve("done");
            });
        });
    }).then(() => { // Drop the notifications collection
        return new Promise((resolve, reject) => {
            console.log(color_start, "Dropping notifications...");
            db.collections['notifications'].drop(function(err) {
                console.log(color_success, 'Notifications collection dropped');
                resolve("done");
            });
        });
    }).then(() => { // Convert the actors csv file to JSON, store in actors_list
        return new Promise((resolve, reject) => {
            console.log(color_start, "Reading actors list...");
            CSVToJSON().fromFile(actor_inputFile).then((json_array) => {
                actors_list = json_array;
                console.log(color_success, "Finished getting the actors_list");
                resolve("done");
            });
        });
    }).then(() => { // Convert the posts csv file to JSON, store in posts_list
        return new Promise((resolve, reject) => {
            console.log(color_start, "Reading posts list...");
            CSVToJSON().fromFile(posts_inputFile).then((json_array) => {
                posts_list = json_array;
                console.log(color_success, "Finished getting the posts list");
                resolve("done");
            });
        });
    }).then(() => { // Generate AI comments and assign actors to each comment
        return new Promise(async (resolve, reject) => {
            console.log(color_start, "Generating AI comments...");
            comment_list = [];

            for (const post of posts_list) {
                const comment = await generateAIComment(post.body);
                const commentDetail = {
                    commentID: generateCommentID(),
                    body: comment,
                    likes: getLikesComment(),
                    harmfuls: getHarmfulsComment(),
                    actor: await getRandomActor(),
                    time: getRandomTimeForComment(),
                    class: post.class
                };
                comment_list.push(commentDetail);
            }

            console.log(color_success, "Finished generating AI comments");
            resolve("done");
        });
    }).then(() => { // Convert the notifications csv file to JSON
        return new Promise((resolve, reject) => {
            console.log(color_start, "Reading notification list...");
            CSVToJSON().fromFile(notifications_inputFile).then((json_array) => {
                notification_list = json_array;
                console.log(color_success, "Finished getting the notification list");
                resolve("done");
            });
        });
    }).then(() => { // Convert the notification replies csv file to JSON
        return new Promise((resolve, reject) => {
            console.log(color_start, "Reading notification reply list...");
            CSVToJSON().fromFile(notifications_replies_inputFile).then((json_array) => {
                notification_reply_list = json_array;
                console.log(color_success, "Finished getting the notification reply list");
                resolve("done");
            });
        });
    }).then(() => { // Populate actors collection
        console.log(color_start, "Starting to populate actors collection...");
        return new Promise((resolve, reject) => {
            async.each(actors_list, async (actor_raw, callback) => {
                const actordetail = {
                    username: actor_raw.username,
                    profile: {
                        name: actor_raw.name,
                        gender: actor_raw.gender,
                        age: actor_raw.age,
                        location: actor_raw.location,
                        bio: actor_raw.bio,
                        picture: actor_raw.picture
                    },
                    class: actor_raw.class
                };

                const actor = new Actor(actordetail);
                try {
                    await actor.save();
                } catch (err) {
                    console.log(color_error, "ERROR: Something went wrong with saving actor in database");
                    callback(err);
                }
            }, (err) => {
                if (err) {
                    console.log(color_error, "ERROR: Something went wrong with saving actors in database");
                } else {
                    console.log(color_success, "All actors added to database!");
                    resolve('Loaded Actors');
                }
            });
        });
    }).then(() => { // Populate posts collection
        console.log(color_start, "Starting to populate posts collection...");
        return new Promise((resolve, reject) => {
            async.each(posts_list, async (new_post, callback) => {
                const act = await Actor.findOne({ username: new_post.actor }).exec();
                if (act) {
                    const postdetail = {
                        postID: new_post.id,
                        body: new_post.body,
                        picture: new_post.picture,
                        likes: new_post.likes || getLikes(),
                        harmfuls: new_post.harmfuls || getHarmfuls(),
                        shares: new_post.shares || getShares(),
                        actor: act,
                        time: timeStringToNum(new_post.time),
                        class: new_post.class
                    };
                    const script = new Script(postdetail);
                    await script.save();
                } else {
                    console.log(color_error, "ERROR: Actor not found in database");
                }
            }, (err) => {
                if (err) {
                    console.log(color_error, "ERROR: Something went wrong with saving posts in database");
                } else {
                    console.log(color_success, "All posts added to database!");
                    resolve('Loaded Posts');
                }
            });
        });
    }).then(() => { // Populate comments with assigned actors
        console.log(color_start, "Starting to populate post replies...");
        return new Promise((resolve, reject) => {
            async.eachSeries(comment_list, async (new_reply, callback) => {
                const act = await Actor.findOne({ username: new_reply.actor }).exec();
                const pr = await Script.findOne({ postID: new_reply.postID }).exec();

                if (act && pr && pr.time <= timeStringToNum(new_reply.time)) {
                    const comment_detail = {
                        commentID: new_reply.commentID,
                        body: new_reply.body,
                        likes: new_reply.likes || getLikesComment(),
                        harmfuls: new_reply.harmfuls || getHarmfulsComment(),
                        actor: act,
                        time: timeStringToNum(new_reply.time),
                        class: new_reply.class
                    };
                    pr.comments.push(comment_detail);
                    pr.comments.sort((a, b) => a.time - b.time);
                    await pr.save();
                } else {
                    console.log(color_error, "ERROR: Actor or post not found, or invalid comment time.");
                }
            }, (err) => {
                if (err) {
                    console.log(color_error, "ERROR: Something went wrong with saving replies in database");
                } else {
                    console.log(color_success, "All replies added to database!");
                    resolve('Loaded Replies');
                }
            });
        });
    });
}

doPopulate();
