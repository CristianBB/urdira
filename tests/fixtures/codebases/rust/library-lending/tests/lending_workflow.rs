use library_lending::{
    Book, InMemoryLibrary, LendingService, LibraryRepository, LoanError, Member,
};

fn service_with_one_book() -> LendingService<InMemoryLibrary> {
    let mut library = InMemoryLibrary::new();
    library.add_book(Book::new("book-1", "A Wizard of Earthsea"));
    library.add_member(Member::new("member-1", "Ged"));
    LendingService::new(library)
}

#[test]
fn successful_loan_persists_the_loan_and_marks_the_book_unavailable() {
    let mut service = service_with_one_book();

    let loan = service.lend_book("book-1", "member-1").unwrap();

    assert_eq!(loan.book_id, "book-1");
    assert_eq!(service.repository().loans(), vec![loan]);
    assert!(!service.find_book("book-1").unwrap().available);
}

#[test]
fn missing_book_returns_a_domain_error() {
    let mut service = service_with_one_book();

    let result = service.lend_book("missing", "member-1");

    assert_eq!(result, Err(LoanError::BookNotFound));
}

#[test]
fn unavailable_book_cannot_be_lent_twice() {
    let mut service = service_with_one_book();
    service.lend_book("book-1", "member-1").unwrap();

    let result = service.lend_book("book-1", "member-1");

    assert_eq!(result, Err(LoanError::BookUnavailable));
}
