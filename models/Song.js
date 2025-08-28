import mongoose from "mongoose";

const SongSchema = new mongoose.Schema({
    title : {type : String, required : true},
    artist : {type : String, required : true},
    url : {type : String, required : true},
    coverImage : {type : String},
}, {timestamps : true})


export default mongoose.models.Song || mongoose.model("Song", SongSchema);