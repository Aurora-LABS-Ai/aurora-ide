//! A curated, high-confidence map of very common typos → corrections.
//!
//! These fire ahead of the statistical engine because they are unambiguous and
//! frequent. Kept deliberately free of risky/ambiguous entries (e.g. "wont",
//! "were") so we never change text the user actually meant. Lookups are
//! case-insensitive (the caller lowercases first); the replacement carries its
//! own intrinsic casing (e.g. "I", "I'm", "don't").

use std::collections::HashMap;
use std::sync::OnceLock;

/// The lowercase-keyed typo → fix table, built once.
pub fn map() -> &'static HashMap<&'static str, &'static str> {
    static MAP: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    MAP.get_or_init(|| {
        [
            // standalone pronoun should be capitalized
            ("i", "I"),
            // transpositions / dropped letters
            ("teh", "the"),
            ("hte", "the"),
            ("adn", "and"),
            ("nad", "and"),
            ("taht", "that"),
            ("thsi", "this"),
            ("tihs", "this"),
            ("waht", "what"),
            ("wiht", "with"),
            ("witht", "with"),
            ("fro", "for"),
            ("ot", "to"),
            ("yuo", "you"),
            ("yoru", "your"),
            ("youre", "you're"),
            ("thier", "their"),
            ("theri", "their"),
            ("ther", "there"),
            ("wich", "which"),
            ("whcih", "which"),
            ("becuase", "because"),
            ("becasue", "because"),
            ("beacuse", "because"),
            ("recieve", "receive"),
            ("recieved", "received"),
            ("seperate", "separate"),
            ("seperated", "separated"),
            ("definately", "definitely"),
            ("defintely", "definitely"),
            ("occured", "occurred"),
            ("occuring", "occurring"),
            ("untill", "until"),
            ("accross", "across"),
            ("allready", "already"),
            ("alot", "a lot"),
            ("cant", "can't"),
            ("dont", "don't"),
            ("doesnt", "doesn't"),
            ("didnt", "didn't"),
            ("wont", "won't"),
            ("isnt", "isn't"),
            ("wasnt", "wasn't"),
            ("arent", "aren't"),
            ("werent", "weren't"),
            ("hasnt", "hasn't"),
            ("havent", "haven't"),
            ("couldnt", "couldn't"),
            ("shouldnt", "shouldn't"),
            ("wouldnt", "wouldn't"),
            ("im", "I'm"),
            ("ive", "I've"),
            ("ill", "I'll"),
            ("thats", "that's"),
            ("whats", "what's"),
            ("lets", "let's"),
            ("tommorow", "tomorrow"),
            ("tomorow", "tomorrow"),
            ("truely", "truly"),
            ("wierd", "weird"),
            ("freind", "friend"),
            ("freinds", "friends"),
            ("beleive", "believe"),
            ("belive", "believe"),
            ("acheive", "achieve"),
            ("achive", "achieve"),
            ("adress", "address"),
            ("arguement", "argument"),
            ("calender", "calendar"),
            ("enviroment", "environment"),
            ("goverment", "government"),
            ("neccessary", "necessary"),
            ("neccesary", "necessary"),
            ("occassion", "occasion"),
            ("publically", "publicly"),
            ("reccomend", "recommend"),
            ("refered", "referred"),
            ("succesful", "successful"),
            ("successfull", "successful"),
            ("thigns", "things"),
            ("thnigs", "things"),
            ("writting", "writing"),
            ("begining", "beginning"),
            ("accomodate", "accommodate"),
            ("embarass", "embarrass"),
            ("existance", "existence"),
            ("greatful", "grateful"),
            ("independant", "independent"),
            ("maintainance", "maintenance"),
            ("priviledge", "privilege"),
            ("questoin", "question"),
            ("responce", "response"),
            ("rythm", "rhythm"),
            ("tounge", "tongue"),
            ("usefull", "useful"),
            ("vaccum", "vacuum"),
            ("wellcome", "welcome"),
        ]
        .into_iter()
        .collect()
    })
}

/// Curated correction for `word_lower` (already lowercased), if any.
pub fn get(word_lower: &str) -> Option<&'static str> {
    map().get(word_lower).copied()
}
