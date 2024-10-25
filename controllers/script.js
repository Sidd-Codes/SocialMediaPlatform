const Script = require('../models/Script.js');
const User = require('../models/User');
const Notification = require('../models/Notification');
const helpers = require('./helpers');
const _ = require('lodash');
const dotenv = require('dotenv');
dotenv.config({ path: '.env' }); // See the file .env.example for the structure of .env

const { OpenAI } = require('openai');
const openai = new OpenAI(process.env.OPENAI_API_KEY);

async function getPostEngagementPredictions(postBody) {
    const response = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: 'You are an assistant that predicts social media post engagement metrics including probable like count, share count, and harmful count.' },
            { role: 'user', content: `Analyze the following post: "${postBody}"` },
        ],
        model: 'gpt-3.5-turbo',
        max_tokens: 100
    });

    const predictions = response.choices[0].message.content;
    return {
        likes: parseInt(predictions.likes),
        shares: parseInt(predictions.shares),
        harmfuls: parseInt(predictions.harmfuls)
    };
}

/**
 * GET /
 * Fetch and render newsfeed.
 */
exports.getScript = async(req, res, next) => {
    try {
        const one_day = 86400000; // Number of milliseconds in a day.
        const time_now = Date.now(); // Current date.
        const time_diff = time_now - req.user.createdAt; // Time difference between now and user account creation, in milliseconds.
        const time_limit = time_diff - one_day; // Date in milliseconds 24 hours ago from now. This is used later to show posts only in the past 24 hours.

        const user = await User.findById(req.user.id)
            .populate('posts.comments.actor')
            .exec();

        // If the user is no longer active, sign the user out.
        if (!user.active) {
            req.logout((err) => {
                if (err) console.log('Error : Failed to logout.', err);
                req.session.destroy((err) => {
                    if (err) console.log('Error : Failed to destroy the session during logout.', err);
                    req.user = null;
                    req.flash('errors', { msg: 'Account is no longer active. Study is over.' });
                    res.redirect('/login' + (req.query.r_id ? `?r_id=${req.query.r_id}` : ""));
                });
            });
        }

        // What day in the study is the user in? 
        // Update study_days, which tracks the number of time user views feed.
        const current_day = Math.floor(time_diff / one_day);
        if (current_day < process.env.NUM_DAYS) {
            user.study_days[current_day] += 1;
            user.save();
        }

        // Array of actor posts that match the user's experimental condition, within the past 24 hours, sorted by descending time. 
        let script_feed = await Script.find({
                class: { "$in": ["", user.experimentalCondition] }
            })
            .where('time').lte(time_diff).gte(time_limit)
            .sort('-time')
            .populate('actor')
            .populate('comments.actor')
            .exec();

        // Array of any user-made posts within the past 24 hours, sorted by time they were created.
        let user_posts = user.getPostInPeriod(time_limit, time_diff);
        user_posts.sort(function(a, b) {
            return b.relativeTime - a.relativeTime;
        });

        // Get the newsfeed and render it.
        const finalfeed = helpers.getFeed(user_posts, script_feed, user, process.env.FEED_ORDER, (process.env.REMOVE_FLAGGED_CONTENT == 'TRUE'), true);
        console.log("Script Size is now: " + finalfeed.length);
        res.render('script', { script: finalfeed, showNewPostIcon: true });
    } catch (err) {
        next(err);
    }
};

/*
 * Post /post/new
 * Record a new user-made post. Include any actor replies (comments) that go along with it.
 */
exports.newPost = async (req, res) => {
    try {
        const user = await User.findById(req.user.id).exec();

        if (req.file) {
            user.numPosts = user.numPosts + 1;
            const currDate = Date.now();

            let post = {
                type: "user_post",
                postID: user.numPosts,
                body: req.body.body,
                picture: req.file.filename,
                liked: false,
                likes: 0,
                harmful: false,
                harmfuls: 0,
                share: false,
                shares: 0,
                comments: [],
                absTime: currDate,
                relativeTime: currDate - user.createdAt,
            };

            const predictions = await getPostEngagementPredictions(req.body.body);
            post.likes = predictions.likes;
            post.shares = predictions.shares;
            post.harmfuls = predictions.harmfuls;

            const actor_replies = await Notification.find()
                .where('userPostID').equals(post.postID)
                .where('notificationType').equals('reply')
                .populate('actor').exec();

            if (actor_replies.length > 0) {
                for (const reply of actor_replies) {
                    user.numActorReplies = user.numActorReplies + 1;
                    const tmp_actor_reply = {
                        actor: reply.actor._id,
                        body: reply.replyBody,
                        commentID: user.numActorReplies,
                        relativeTime: post.relativeTime + reply.time,
                        absTime: new Date(user.createdAt.getTime() + post.relativeTime + reply.time),
                        new_comment: false,
                        liked: false,
                        harmful: false,
                        likes: 0,
                        harmfuls: 0
                    };
                    post.comments.push(tmp_actor_reply);
                }
            }

            user.posts.unshift(post);
            await user.save();
            res.redirect('/');
        } else {
            req.flash('errors', { msg: 'ERROR: Your post did not get sent. Please include a photo and a caption.' });
            res.redirect('/');
        }
    } catch (err) {
        next(err);
    }
};

/**
 * POST /feed/
 * Record user's actions on ACTOR posts. 
 */
exports.postUpdateFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Check if user has interacted with the post before.
        let feedIndex = _.findIndex(user.feedAction, function(o) { return o.post == req.body.postID; });

        // If the user has not interacted with the post before, add the post to user.feedAction.
        if (feedIndex == -1) {
            const cat = {
                post: req.body.postID,
                postClass: req.body.postClass,
            };
            feedIndex = user.feedAction.push(cat) - 1;
        }

        // User created a new comment on the post.
        if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                new_comment: true,
                new_comment_id: user.numComments,
                body: req.body.comment_text,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                liked: false,
                shared: false,
                harmful: false,
            }
            user.feedAction[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const isUserComment = (req.body.isUserComment == 'true');
            // Check if user has interacted with the comment before.
            let commentIndex = (isUserComment) ?
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.new_comment_id == req.body.commentID && o.new_comment == isUserComment
                }) :
                _.findIndex(user.feedAction[feedIndex].comments, function(o) {
                    return o.comment == req.body.commentID && o.new_comment == isUserComment
                });

            // If the user has not interacted with the comment before, add the comment to user.feedAction[feedIndex].comments
            if (commentIndex == -1) {
                const cat = {
                    comment: req.body.commentID
                };
                user.feedAction[feedIndex].comments.push(cat);
                commentIndex = user.feedAction[feedIndex].comments.length - 1;
            }

            // User liked the comment.
            if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].comments[commentIndex].likeTime.push(like);
                user.feedAction[feedIndex].comments[commentIndex].liked = true;
                if (req.body.isUserComment != 'true') user.numCommentLikes++;
            }

            // User unliked the comment.
            if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].comments[commentIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].comments[commentIndex].liked = false;
                if (req.body.isUserComment != 'true') user.numCommentLikes--;
            }

            // User harmful the comment.
            if (req.body.harmful) {
                const harmful = req.body.harmful;
                user.feedAction[feedIndex].comments[commentIndex].harmfulTime.push(harmful);
                user.feedAction[feedIndex].comments[commentIndex].harmful = true;
                if (req.body.isUserComment != 'true') user.numCommentHarmfuls++;
            }

            // User unharmful the comment.
            if (req.body.unharmful) {
                const unharmful = req.body.unharmful;
                user.feedAction[feedIndex].comments[commentIndex].unharmfulTime.push(unharmful);
                user.feedAction[feedIndex].comments[commentIndex].harmful = false;
                if (req.body.isUserComment != 'true') user.numCommentHarmfuls--;
            }

            // User liked the post.
            else if (req.body.like) {
                const like = req.body.like;
                user.feedAction[feedIndex].likeTime.push(like);
                user.feedAction[feedIndex].liked = true;
                user.numPostLikes++;
            }
            // User unliked the post.
            else if (req.body.unlike) {
                const unlike = req.body.unlike;
                user.feedAction[feedIndex].unlikeTime.push(unlike);
                user.feedAction[feedIndex].liked = false;
                user.numPostLikes--;
            }
            // User share the post.
            else if (req.body.share) {
                const share = req.body.share;
                user.feedAction[feedIndex].likeTime.push(share);
                user.feedAction[feedIndex].shared = true;
                user.numPostShares++;
            }
            // User unshare the post.
            else if (req.body.unshare) {
                const unshare = req.body.unshare;
                user.feedAction[feedIndex].unshareTime.push(unshare);
                user.feedAction[feedIndex].shared = false;
                user.numPostShares--;
            }
            // User harmful the post.
            else if (req.body.harmful) {
                const harmful = req.body.harmful;
                user.feedAction[feedIndex].harmfulTime.push(harmful);
                user.feedAction[feedIndex].harmfuld = true;
                user.numPostharmfuls++;
            }
            // User unharmful the post.
            else if (req.body.unharmful) {
                const unharmful = req.body.unharmful;
                user.feedAction[feedIndex].unharmfulTime.push(unharmful);
                user.feedAction[feedIndex].harmfuld = false;
                user.numPostharmfuls--;
            }
            // User read the post.
            else if (req.body.viewed) {
                const view = req.body.viewed;
                user.feedAction[feedIndex].readTime.push(view);
                user.feedAction[feedIndex].rereadTimes++;
                user.feedAction[feedIndex].mostRecentTime = Date.now();
            } else {
                console.log('Something in feedAction went crazy. You should never see this.');
            }
        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
};

/**
 * POST /userPost_feed/
 * Record user's actions on USER posts. 
 */
exports.postUpdateUserPostFeedAction = async(req, res, next) => {
    try {
        const user = await User.findById(req.user.id).exec();
        // Find the index of object in user.posts
        let feedIndex = _.findIndex(user.posts, function(o) { return o.postID == req.body.postID; });

        if (feedIndex == -1) {
            // Should not happen.
        }
        // User created a new comment on the post.
        else if (req.body.new_comment) {
            user.numComments = user.numComments + 1;
            const cat = {
                body: req.body.comment_text,
                commentID: user.numComments,
                relativeTime: req.body.new_comment - user.createdAt,
                absTime: req.body.new_comment,
                new_comment: true,
                liked: false,
                harmful: false,
                likes: 0,
                harmfuls: 0
            };
            user.posts[feedIndex].comments.push(cat);
        }
        // User interacted with a comment on the post.
        else if (req.body.commentID) {
            const commentIndex = _.findIndex(user.posts[feedIndex].comments, function(o) {
                return o.commentID == req.body.commentID && o.new_comment == (req.body.isUserComment == 'true');
            });
            if (commentIndex == -1) {
                console.log("Should not happen.");
            }
            // User liked the comment.
            else if (req.body.like) {
                user.posts[feedIndex].comments[commentIndex].liked = true;
            }
            // User unliked the comment. 
            else if (req.body.unlike) {
                user.posts[feedIndex].comments[commentIndex].liked = false;
            }
            // User harmful the comment.
            else if (req.body.harmful) {
                user.posts[feedIndex].comments[commentIndex].harmful = true;
            }
            // User unharmfulthe comment. 
            else if (req.body.unharmful) {
                user.posts[feedIndex].comments[commentIndex].harmful = false;
            }
        }
        // User interacted with the post. 
        else {
            // User liked the post.
            if (req.body.like) {
                user.posts[feedIndex].liked = true;
            }
            // User unliked the post.
            if (req.body.unlike) {
                user.posts[feedIndex].liked = false;
            }
            // User harmful the post.
            if (req.body.harmful) {
                user.posts[feedIndex].harmful = true;
            }
            // User unharmful the post.
            if (req.body.unharmful) {
                user.posts[feedIndex].harmful = false;
            }
            // User harmful the post.
            if (req.body.share) {
                user.posts[feedIndex].shared = true;
            }
            // User unliked the post.
            if (req.body.unshare) {
                user.posts[feedIndex].shared = false;
            }

        }
        await user.save();
        res.send({ result: "success", numComments: user.numComments });
    } catch (err) {
        next(err);
    }
}