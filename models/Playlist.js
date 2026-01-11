import mongoose from "mongoose";
//nothing

const PlaylistSchema = new mongoose.Schema({
    name : {type : String, required : true},
    coverImage : {type : String, required : true, default: "/playlist.png"},
    songs: [{ type: mongoose.Schema.Types.ObjectId, ref: "Song" }],


}, {timestamps : true})

// Export the schema so it can be used with different connections
export { PlaylistSchema };
export default PlaylistSchema;