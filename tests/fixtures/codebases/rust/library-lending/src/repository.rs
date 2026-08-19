use std::collections::BTreeMap;

use crate::{Book, Loan, Member};

pub trait LibraryRepository {
    fn find_book(&self, book_id: &str) -> Option<Book>;
    fn find_member(&self, member_id: &str) -> Option<Member>;
    fn save_book(&mut self, book: Book);
    fn save_loan(&mut self, loan: Loan);
    fn loans(&self) -> Vec<Loan>;
}

#[derive(Default)]
pub struct InMemoryLibrary {
    books: BTreeMap<String, Book>,
    members: BTreeMap<String, Member>,
    loans: Vec<Loan>,
}

impl InMemoryLibrary {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_book(&mut self, book: Book) {
        self.books.insert(book.id.clone(), book);
    }

    pub fn add_member(&mut self, member: Member) {
        self.members.insert(member.id.clone(), member);
    }
}

impl LibraryRepository for InMemoryLibrary {
    fn find_book(&self, book_id: &str) -> Option<Book> {
        self.books.get(book_id).cloned()
    }

    fn find_member(&self, member_id: &str) -> Option<Member> {
        self.members.get(member_id).cloned()
    }

    fn save_book(&mut self, book: Book) {
        self.books.insert(book.id.clone(), book);
    }

    fn save_loan(&mut self, loan: Loan) {
        self.loans.push(loan);
    }

    fn loans(&self) -> Vec<Loan> {
        self.loans.clone()
    }
}
