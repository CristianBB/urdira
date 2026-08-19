#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Book {
    pub id: String,
    pub title: String,
    pub available: bool,
}

impl Book {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            available: true,
        }
    }

    pub fn mark_lent(&mut self) {
        self.available = false;
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Member {
    pub id: String,
    pub name: String,
}

impl Member {
    pub fn new(id: impl Into<String>, name: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Loan {
    pub book_id: String,
    pub member_id: String,
}

impl Loan {
    pub fn new(book_id: impl Into<String>, member_id: impl Into<String>) -> Self {
        Self {
            book_id: book_id.into(),
            member_id: member_id.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LoanError {
    BookNotFound,
    MemberNotFound,
    BookUnavailable,
}
