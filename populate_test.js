const async = require('async');
const Actor = require('./models/Actor.js');
const Script = require('./models/Script.js');
const Notification = require('./models/Notification.js');
const _ = require('lodash');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const CSVToJSON = require("csvtojson");

//Input Files
const actor_inputFile = './input/actors.csv';
const posts_inputFile = './input/posts.csv';
const replies_inputFile = './input/replies.csv';
const notifications_inputFile = './input/notifications (read, like).csv';
const notifications_replies_inputFile = './input/notifications (reply).csv';

// Variables to be used later.
var actors_list;
var posts_list;
var comment_list;
var notification_list;
var notification_reply_list;

dotenv.config({ path: '.env' });

mongoose.connect(process.env.MONGODB_URI || process.env.MONGOLAB_URI, { useNewUrlParser: true });
var db = mongoose.connection;
mongoose.connection.on('error', (err) => {
  console.error(err);
  console.log(color_error, '%s MongoDB connection error. Please make sure MongoDB is running.');
  process.exit(1);
});


async function doPopulate() {
  try {
    console.log(color_start, "Dropping collections...");
    await db.collections['actors'].drop();
    console.log(color_success, 'Actors collection dropped');
    await db.collections['scripts'].drop();
    console.log(color_success, 'Scripts collection dropped');
    await db.collections['notifications'].drop();
    console.log(color_success, 'Notifications collection dropped');

    console.log(color_start, "Reading data from CSV files...");
    actors_list = await CSVToJSON().fromFile(actor_inputFile);
    posts_list = await CSVToJSON().fromFile(posts_inputFile);
    comment_list = await CSVToJSON().fromFile(replies_inputFile);
    notification_list = await CSVToJSON().fromFile(notifications_inputFile);
    notification_reply_list = await CSVToJSON().fromFile(notifications_replies_inputFile);
    console.log(color_success, "Finished reading data.");

    /*************************
     Create all the Actors in the simulation
     Must be done before creating any other instances
     *************************/
    console.log(color_start, "Starting to populate actors collection...");
    await new Promise((resolve, reject) => {
      async.each(actors_list, async function (actor_raw, callback) {
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
          reject(err); // Reject the promise if an error occurs
        }
      },
        function (err) {
          if (err) {
            console.log(color_error, "ERROR: Something went wrong with saving actors in database");
            reject(err); // Reject the promise if an error occurs
          }
          // Return response
          console.log(color_success, "All actors added to database!")
          resolve('Promise is resolved successfully.');
          return 'Loaded Actors';
        }
      );
    });

    /*************************
     Create each post and upload it to the DB
     Actors must be in DB first to add them correctly to the post
     *************************/
    console.log(color_start, "Starting to populate posts collection...");
    await new Promise((resolve, reject) => {
      async.each(posts_list, async function (new_post, callback) {
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
            time: timeStringToNum(new_post.time) || null,
            class: new_post.class
          }

          const script = new Script(postdetail);
          try {
            await script.save();
          } catch (err) {
            console.log(color_error, "ERROR: Something went wrong with saving post in database");
            reject(err); // Reject the promise if an error occurs
          }
        } else { //Else no actor found
          console.log(color_error, "ERROR: Actor not found in database");
          callback();
        };
      },
        function (err) {
          if (err) {
            console.log(color_error, "ERROR: Something went wrong with saving posts in database");
            reject(err); // Reject the promise if an error occurs
          }
          // Return response
          console.log(color_success, "All posts added to database!")
          resolve('Promise is resolved successfully.');
          return 'Loaded Posts';
        }
      );
    });

    /*************************
     Creates inline comments for each post
     Looks up actors and posts to insert the correct comment
     Does this in series to insure comments are put in the correct order
     Takes a while to run because of this.
     *************************/
    console.log(color_start, "Starting to populate post replies...");
    await new Promise((resolve, reject) => {
      async.eachSeries(comment_list, async function (new_reply, callback) {
        // Add this line to log new_reply details
        console.log('Processing new_reply:', new_reply);
        const act = await Actor.findOne({ username: new_reply.actor }).exec();
        if (act) {
          const pr = await Script.findOne({ postID: new_reply.postID }).exec();
          if (pr) {
            if (pr.time > timeStringToNum(new_reply.time)) {
              console.log(color_error, "ERROR: The simulated time for this comment (commentID: " + new_reply.id + ") is before the simulated time of the post.");
              reject(err); // Reject the promise if an error occurs
            }
            const comment_detail = {
              commentID: new_reply.id,
              body: new_reply.body,
              likes: new_reply.likes || getLikesComment(),
              harmfuls: new_reply.harmfuls || getHarmfulsComment(),
              actor: act,
              time: timeStringToNum(new_reply.time),
              class: new_reply.class
            };
            pr.comments.push(comment_detail);
            pr.comments.sort(function (a, b) { return a.time - b.time; });
            console.log("Full pr object before saving:", pr);

            try {
              await pr.save();
            } catch (err) {
              console.log(color_error, "ERROR: Something went wrong with saving reply in database");
              console.log("Full error object:", err);
              reject(err); // Reject the promise if an error occurs
            }
          } else { //Else no post found
            console.log(color_error, "ERROR: Post not found in database");
            callback();
          }

        } else { //Else no actor found
          console.log(color_error, "ERROR: Actor not found in database");
          callback();
        }
      },
        function (err) {
          if (err) {
            console.log(color_error, "ERROR: Something went wrong with saving replies in database");
            reject(err); // Reject the promise if an error occurs
          }
          // Return response
          console.log(color_success, "All replies added to database!");
          resolve('Promise is resolved successfully.');
          return 'Loaded Replies';
        }
      );
    });

    /*************************
     Creates each notification(replies) and uploads it to the DB
     Actors must be in DB first to add them correctly to the post
     *************************/
    console.log(color_start, "Starting to populate notifications (replies) collection...");
    await new Promise((resolve, reject) => {
      async.each(notification_reply_list, async