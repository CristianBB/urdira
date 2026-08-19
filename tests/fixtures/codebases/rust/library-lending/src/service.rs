use crate::{Book, LibraryRepository, Loan, LoanError};

pub struct LendingService<R: LibraryRepository> {
    repository: R,
}

impl<R: LibraryRepository> LendingService<R> {
    pub fn new(repository: R) -> Self {
        Self { repository }
    }

    pub fn lend_book(&mut self, book_id: &str, member_id: &str) -> Result<Loan, LoanError> {
        let mut book = self
            .repository
            .find_book(book_id)
            .ok_or(LoanError::BookNotFound)?;

        self.repository
            .find_member(member_id)
            .ok_or(LoanError::MemberNotFound)?;

        if !book.available {
            return Err(LoanError::BookUnavailable);
        }

        book.mark_lent();
        let loan = Loan::new(book.id.clone(), member_id);
        self.repository.save_book(book);
        self.repository.save_loan(loan.clone());

        Ok(loan)
    }

    pub fn repository(&self) -> &R {
        &self.repository
    }

    pub fn find_book(&self, book_id: &str) -> Option<Book> {
        self.repository.find_book(book_id)
    }
}
